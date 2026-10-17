const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const app = express();
const dataDirectory = process.env.DATA_DIR || path.join(__dirname, 'data');
const usersFile = path.join(dataDirectory, 'users.json');
const marketListingsFile = path.join(dataDirectory, 'market.json');

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required in production.');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
}));

const initialAdmin = {
    id: 1,
    username: 'КранчиЕблан',
    passwordHash: '$2b$12$lt/mr8NclA7QVZHHOB2h1e9m3A/34uxXAAGLnlQabicdyTsKMIvaq',
    role: 'admin',
    balance: 10000,
    coinsEarned: 10000,
    coinsSpent: 0,
    card: 'Нет карты',
    inventory: [],
    dailyRouletteDate: null,
    bonusRouletteSpins: 0,
    experience: 0
};
let users = [];
let marketListings = [];

function normalizeUsername(username) {
    return username.trim().toLocaleLowerCase('ru-RU');
}

function getCurrentUser(req) {
    return users.find((user) => user.id === req.session.userId);
}

function getRequiredExperienceForLevel(level) {
    const normalizedLevel = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
    return normalizedLevel * 100;
}

function getUserLevel(user) {
    const experience = Number.isSafeInteger(user.experience) ? user.experience : 0;
    return Math.max(0, Math.floor(experience / 100));
}

function getNextLevelProgress(user) {
    const experience = Number.isSafeInteger(user.experience) ? user.experience : 0;
    const level = getUserLevel(user);
    const currentLevelThreshold = getRequiredExperienceForLevel(level);
    const nextLevelThreshold = getRequiredExperienceForLevel(level + 1);
    const xpIntoLevel = Math.max(0, experience - currentLevelThreshold);
    const xpForNextLevel = Math.max(1, nextLevelThreshold - currentLevelThreshold);
    const progressPercent = Math.min(100, Math.max(0, (xpIntoLevel / xpForNextLevel) * 100));

    return {
        level,
        experience,
        xpIntoLevel,
        xpForNextLevel,
        progressPercent,
        xpRemaining: Math.max(0, nextLevelThreshold - experience)
    };
}

function getRouletteStatus(user) {
    const today = new Date().toISOString().slice(0, 10);
    return {
        dailyAvailable: user.dailyRouletteDate !== today,
        bonusSpins: user.bonusRouletteSpins || 0
    };
}

function getGachaStatus(user) {
    const today = new Date().toISOString().slice(0, 10);
    return {
        dailyAvailable: user.dailyGachaDate !== today,
        bonusSpins: user.bonusGachaSpins || 0
    };
}

function publicUser(user) {
    const { passwordHash, ...safeUser } = user;
    return {
        ...safeUser,
        roulette: getRouletteStatus(user),
        gacha: getGachaStatus(user),
        caseCount: user.caseCount || 0,
        level: getUserLevel(user),
        nextLevelProgress: getNextLevelProgress(user)
    };
}

function addExperience(user, amount) {
    user.experience = (Number.isSafeInteger(user.experience) ? user.experience : 0) + amount;
}

let saveQueue = Promise.resolve();

function saveUsers() {
    const save = async () => {
        await fs.mkdir(path.dirname(usersFile), { recursive: true });
        const temporaryFile = `${usersFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temporaryFile, JSON.stringify(users, null, 2), { encoding: 'utf8', mode: 0o600 });

        try {
            for (let attempt = 0; ; attempt += 1) {
                try {
                    await fs.rename(temporaryFile, usersFile);
                    return;
                } catch (error) {
                    const canRetry = process.platform === 'win32'
                        && ['EPERM', 'EACCES', 'EEXIST'].includes(error.code)
                        && attempt < 3;
                    if (!canRetry) throw error;
                    await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
                }
            }
        } finally {
            await fs.rm(temporaryFile, { force: true });
        }
    };

    saveQueue = saveQueue.catch(() => {}).then(save);
    return saveQueue;
}

async function saveMarketListings() {
    await fs.mkdir(path.dirname(marketListingsFile), { recursive: true });
    const temporaryFile = `${marketListingsFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(marketListings, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
        for (let attempt = 0; ; attempt += 1) {
            try {
                await fs.rename(temporaryFile, marketListingsFile);
                return;
            } catch (error) {
                const canRetry = process.platform === 'win32'
                    && ['EPERM', 'EACCES', 'EEXIST'].includes(error.code)
                    && attempt < 3;
                if (!canRetry) throw error;
                await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
            }
        }
    } finally {
        await fs.rm(temporaryFile, { force: true });
    }
}

async function loadUsers() {
    await fs.mkdir(path.dirname(usersFile), { recursive: true });
    try {
        const savedUsers = JSON.parse(await fs.readFile(usersFile, 'utf8'));
        if (!Array.isArray(savedUsers)) throw new Error('Файл пользователей должен содержать список.');
        users = savedUsers;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        users = [{ ...initialAdmin, inventory: [...initialAdmin.inventory] }];
        await saveUsers();
    }

    for (const user of users) {
        if (!Array.isArray(user.inventory)) user.inventory = [];
        if (!Number.isSafeInteger(user.bonusRouletteSpins)) user.bonusRouletteSpins = 0;
        if (!('dailyRouletteDate' in user)) user.dailyRouletteDate = null;
        if (!('dailyGachaDate' in user)) user.dailyGachaDate = null;
        if (!Number.isSafeInteger(user.caseCount)) user.caseCount = 0;
        if (!Number.isSafeInteger(user.bonusGachaSpins)) user.bonusGachaSpins = 0;
        if (!Number.isSafeInteger(user.coinsEarned)) user.coinsEarned = user.balance;
        if (!Number.isSafeInteger(user.coinsSpent)) user.coinsSpent = 0;
        if (!Number.isSafeInteger(user.experience) || user.experience < 0) user.experience = 0;
    }

    const adminExists = users.some((user) => normalizeUsername(user.username || '') === normalizeUsername(initialAdmin.username));
    if (!adminExists) users.unshift({ ...initialAdmin, inventory: [...initialAdmin.inventory] });
    await saveUsers();
}

async function loadMarketListings() {
    try {
        const savedListings = JSON.parse(await fs.readFile(marketListingsFile, 'utf8'));
        marketListings = Array.isArray(savedListings) ? savedListings : [];
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        marketListings = [];
    }
}

const cardRarities = {
    'Гузель Арматуровна': 'teachers',
    'Эльмира Ракидовна': 'teachers',
    'Гузель Ахметова': 'teachers',
    'Насима Зуфаровна': 'teachers',
    'Ирина Валерьевна': 'teachers',
    'Валерий Акрамович': 'teachers',
    'Михаил Николаевич': 'teachers',
    'Ильгиз Винерович': 'teachers',
    'Филярия Талгатовна': 'teachers',
    'Наталья Николаевна': 'teachers',
    'Дилара Галимовна': 'teachers',
    'Гульсум Муратовна': 'teachers',
    'Эльвира Хасановна': 'teachers',
    'Амилия': 'secret',
    'Артём': 'secret',
    'Даниэль Султангулов': 'secret',
    'Саида': 'secret',
    'Тимур': 'secret',
    'Валерия': 'ultra',
    'Рустам': 'legendary',
    'Даниэль': 'legendary',
    'Миша': 'legendary',
    'Константин': 'legendary',
    'Мися': 'legendary',
    'Егор': 'rare',
    'Тамерлан Гиндуллин': 'mythic',
    'Глафира': 'mythic',
    'Трофим': 'mythic',
    'Данияр Жайлибаев': 'epic',
    'Эмин': 'epic',
    'Равиль': 'epic',
    'Данияр Садыков': 'epic',
    'Азат': 'super-rare',
    'Маша': 'super-rare',
    'Милана': 'super-rare',
    'Олег': 'common',
    'Камила': 'common',
    'Карина': 'common'
};
const rarityRanks = {
    common: 0,
    rare: 1,
    'super-rare': 2,
    epic: 3,
    mythic: 4,
    legendary: 5,
    secret: 6,
    teachers: 7,
    ultra: 8
};
const gachaRarityRates = [
    { rarity: 'common', chance: 67 },
    { rarity: 'rare', chance: 0.15 },
    { rarity: 'super-rare', chance: 20 },
    { rarity: 'epic', chance: 8 },
    { rarity: 'mythic', chance: 3 },
    { rarity: 'legendary', chance: 1 },
    { rarity: 'secret', chance: 0.5 },
    { rarity: 'teachers', chance: 0.3 },
    { rarity: 'ultra', chance: 0.05 }
];
const rarityLabels = {
    common: 'Обычная',
    rare: 'Редкая',
    'super-rare': 'Сверхредкая',
    epic: 'Эпическая',
    mythic: 'Мифическая',
    legendary: 'Легендарная',
    secret: 'Секретка',
    teachers: 'Учителя',
    ultra: 'Ультралегендарная'
};
const caseRarityRates = [
    { rarity: 'epic', chance: 82 },
    { rarity: 'mythic', chance: 12 },
    { rarity: 'legendary', chance: 3 },
    { rarity: 'secret', chance: 1.25 },
    { rarity: 'teachers', chance: 1 },
    { rarity: 'ultra', chance: 0.75 }
];

function drawCardFromRates(rates) {
    const roll = Math.random() * 100;
    let cumulativeChance = 0;
    for (const pool of rates) {
        cumulativeChance += pool.chance;
        if (roll >= cumulativeChance) continue;

        const poolCards = Object.entries(cardRarities)
            .filter(([, rarity]) => rarity === pool.rarity)
            .map(([name]) => name);
        const name = poolCards[Math.floor(Math.random() * poolCards.length)];
        return { name, rarity: pool.rarity, rarityLabel: rarityLabels[pool.rarity] };
    }
    throw new Error('Не удалось выбрать редкость карты из списка шансов.');
}

function drawGachaCard() {
    return drawCardFromRates(gachaRarityRates);
}

function drawCaseCard() {
    return drawCardFromRates(caseRarityRates);
}

function establishSession(req, res, user, statusCode = 200) {
    req.session.regenerate((regenerateError) => {
        if (regenerateError) return res.status(500).json({ message: 'Не удалось создать сессию.' });
        req.session.userId = user.id;
        req.session.save((saveError) => {
            if (saveError) return res.status(500).json({ message: 'Не удалось сохранить сессию.' });
            res.status(statusCode).json({ success: true, user: publicUser(user) });
        });
    });
}

app.post('/api/register', async (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
        return res.status(400).json({ message: 'Ник: 3–20 символов, только английские буквы, цифры и _.' });
    }
    if (password.length < 8 || password.length > 128) {
        return res.status(400).json({ message: 'Пароль должен содержать от 8 до 128 символов.' });
    }

    const usernameKey = normalizeUsername(username);
    if (users.some((user) => normalizeUsername(user.username) === usernameKey)) {
        return res.status(409).json({ message: 'Этот ник уже занят.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    if (users.some((user) => normalizeUsername(user.username) === usernameKey)) {
        return res.status(409).json({ message: 'Этот ник уже занят.' });
    }

    const user = {
        id: Math.max(0, ...users.map((item) => item.id)) + 1,
        username,
        passwordHash,
        role: 'user',
        balance: 1000,
        coinsEarned: 1000,
        coinsSpent: 0,
        card: 'Олег',
        inventory: ['Олег'],
        dailyRouletteDate: null,
        bonusRouletteSpins: 0,
        dailyGachaDate: null,
        bonusGachaSpins: 0,
        caseCount: 0,
        experience: 0
    };
    users.push(user);
    try {
        await saveUsers();
    } catch {
        users = users.filter((item) => item.id !== user.id);
        return res.status(500).json({ message: 'Не удалось сохранить аккаунт.' });
    }
    establishSession(req, res, user, 201);
});

app.post('/api/login', async (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const user = users.find((item) => normalizeUsername(item.username) === normalizeUsername(username));

    if (!user || !await bcrypt.compare(password, user.passwordHash)) {
        return res.status(401).json({ message: 'Неверный ник или пароль.' });
    }
    establishSession(req, res, user);
});

app.post('/api/logout', async (req, res) => {
    try {
        await saveUsers();
    } catch {
        return res.status(500).json({ message: 'Не удалось сохранить данные перед выходом.' });
    }
    req.session.destroy((error) => {
        if (error) return res.status(500).json({ message: 'Не удалось завершить сессию.' });
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

app.get('/api/me', (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Не авторизован' });
    res.json(publicUser(user));
});

app.get('/healthz', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/api/balance-stats', (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'Сначала войди в игру.' });
    res.json({
        balance: user.balance,
        earned: user.coinsEarned,
        spent: user.coinsSpent,
        net: user.coinsEarned - user.coinsSpent
    });
});

app.get('/api/leaderboard', (req, res) => {
    const currentUser = getCurrentUser(req);
    if (!currentUser) return res.status(401).json({ message: 'Сначала войди в игру.' });

    const rankedUsers = [...users].sort((left, right) =>
        right.balance - left.balance || left.username.localeCompare(right.username, 'ru-RU')
    );
    res.json({
        entries: rankedUsers.slice(0, 10).map((user, index) => ({
            rank: index + 1,
            username: user.username,
            balance: user.balance,
            isCurrentUser: user.id === currentUser.id
        })),
        currentRank: rankedUsers.findIndex((user) => user.id === currentUser.id) + 1
    });
});

app.get('/api/leaderboard/levels', (req, res) => {
    const currentUser = getCurrentUser(req);
    if (!currentUser) return res.status(401).json({ message: 'Сначала войди в игру.' });

    const rankedUsers = [...users].sort((left, right) =>
        getUserLevel(right) - getUserLevel(left)
        || (right.experience || 0) - (left.experience || 0)
        || left.username.localeCompare(right.username, 'ru-RU')
    );
    res.json({
        entries: rankedUsers.slice(0, 10).map((user, index) => ({
            rank: index + 1,
            username: user.username,
            level: getUserLevel(user),
            experience: user.experience || 0,
            isCurrentUser: user.id === currentUser.id
        })),
        currentRank: rankedUsers.findIndex((user) => user.id === currentUser.id) + 1
    });
});

app.get('/api/market/listings', (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'Сначала войди в игру.' });

    const safeListings = marketListings.map((listing) => ({
        ...listing,
        sellerUsername: listing.sellerUsername || 'Игрок',
        marketPrice: listing.marketPrice || 0
    }));
    res.json({
        listings: safeListings,
        myListings: safeListings.filter((listing) => listing.sellerId === user.id),
        myCards: Array.from(new Set(user.inventory)),
        currentUserId: user.id
    });
});

app.post('/api/market/sell', async (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'Сначала войди в игру.' });

    const cardName = typeof req.body.cardName === 'string' ? req.body.cardName.trim() : '';
    const salePrice = Number(req.body.price);

    if (!cardName || !cardName.length || !cardRarities[cardName]) {
        return res.status(400).json({ message: 'Выбери карту из инвентаря.' });
    }
    if (!Number.isSafeInteger(salePrice) || salePrice <= 0) {
        return res.status(400).json({ message: 'Цена должна быть положительным целым числом.' });
    }
    if (user.inventory.filter((name) => name === cardName).length === 0) {
        return res.status(400).json({ message: 'Такой карты нет в твоём инвентаре.' });
    }
    if (marketListings.some((listing) => listing.sellerId === user.id && listing.cardName === cardName)) {
        return res.status(400).json({ message: 'Эта карта уже выставлена на продажу.' });
    }

    const marketPrice = Number(req.body.marketPrice) || salePrice;
    const listing = {
        id: crypto.randomUUID(),
        sellerId: user.id,
        sellerUsername: user.username,
        cardName,
        price: salePrice,
        marketPrice,
        createdAt: new Date().toISOString()
    };

    marketListings.push(listing);
    await saveMarketListings();
    res.json({ success: true, listing, message: `Карта «${cardName}» выставлена на базар.` });
});

app.post('/api/market/buy/:id', async (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'Сначала войди в игру.' });

    const listing = marketListings.find((item) => item.id === req.params.id);
    if (!listing) return res.status(404).json({ message: 'Лот не найден.' });
    if (listing.sellerId === user.id) return res.status(400).json({ message: 'Нельзя купить свою же карту.' });
    if (user.balance < listing.price) return res.status(400).json({ message: 'У тебя не хватает монет для покупки.' });

    const seller = users.find((entry) => entry.id === listing.sellerId);
    if (!seller) return res.status(404).json({ message: 'Продавец больше не существует.' });

    const sellerCardIndex = seller.inventory.indexOf(listing.cardName);
    if (sellerCardIndex === -1) {
        marketListings = marketListings.filter((item) => item.id !== listing.id);
        await saveMarketListings();
        return res.status(404).json({ message: 'У продавца больше нет этой карты.' });
    }

    user.balance -= listing.price;
    seller.balance += listing.price;
    user.coinsSpent += listing.price;
    seller.coinsEarned += listing.price;
    user.inventory.push(listing.cardName);
    seller.inventory.splice(sellerCardIndex, 1);
    addExperience(user, 50);
    marketListings = marketListings.filter((item) => item.id !== listing.id);
    await saveUsers();
    await saveMarketListings();

    res.json({ success: true, message: `Ты купил «${listing.cardName}» у ${seller.username}.`, balance: user.balance, inventory: user.inventory });
});

app.delete('/api/market/listings/:id', async (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'Сначала войди в игру.' });

    const listingIndex = marketListings.findIndex((item) => item.id === req.params.id && item.sellerId === user.id);
    if (listingIndex === -1) return res.status(404).json({ message: 'Твой лот не найден.' });

    marketListings.splice(listingIndex, 1);
    await saveMarketListings();
    res.json({ success: true, message: 'Лот удалён с базара.' });
});

// Сделать ставку в казино (пример кнопки)
app.post('/api/casino', async (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ error: 'Не авторизован' });
    const bet = Number(req.body.bet);

    if (!Number.isSafeInteger(bet) || bet <= 0) {
        return res.status(400).json({ message: 'Ставка должна быть целым числом больше нуля.' });
    }
    if (bet > user.balance) {
        return res.status(400).json({ message: 'Ставка больше твоего баланса.' });
    }

    const win = Math.random() < 0.5;
    user.balance += win ? bet : -bet;
    if (win) user.coinsEarned += bet;
    else user.coinsSpent += bet;
    await saveUsers();
    res.json({
        success: true,
        win,
        message: win ? `Победа! Ты выиграл ${bet} очков.` : `Проигрыш! Ты потерял ${bet} очков.`,
        balance: user.balance
    });
});

app.post('/api/roulette', async (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'Игрок не найден.' });

    const roulette = getRouletteStatus(user);
    let spinType;
    if (roulette.dailyAvailable) {
        user.dailyRouletteDate = new Date().toISOString().slice(0, 10);
        spinType = 'daily';
    } else if (roulette.bonusSpins > 0) {
        user.bonusRouletteSpins -= 1;
        spinType = 'bonus';
    } else {
        return res.status(429).json({ message: 'Рулетка уже использована сегодня.', roulette });
    }

    const caseWon = Math.random() < 0.1;
    let prize = null;
    let message;
    if (caseWon) {
        user.caseCount = (user.caseCount || 0) + 1;
        message = `Выпал кейс! Теперь у тебя кейсов: ${user.caseCount}.`;
    } else {
        const prizes = [25, 50, 100, 250];
        prize = prizes[Math.floor(Math.random() * prizes.length)];
        user.balance += prize;
        user.coinsEarned += prize;
        message = `Рулетка принесла ${prize} монет!`;
    }
    addExperience(user, 100);
    await saveUsers();

    res.json({
        success: true,
        spinType,
        caseWon,
        prize,
        balance: user.balance,
        caseCount: user.caseCount || 0,
        experience: user.experience,
        roulette: getRouletteStatus(user),
        xpAwarded: 100,
        message
    });
});

app.post('/api/gacha', async (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'Сначала войди в игру.' });

    const count = Number(req.body.count);
    if (count !== 1 && count !== 10) {
        return res.status(400).json({ message: 'Можно открыть 1 или 10 карт.' });
    }
    const gachaStatus = getGachaStatus(user);
    if (!gachaStatus.dailyAvailable && gachaStatus.bonusSpins === 0) {
        return res.status(429).json({ message: 'Северо-Юг уже использован сегодня.' });
    }

    const cost = count * 100;
    if (user.balance < cost) return res.status(400).json({ message: 'Не хватает монет для этой попытки.' });

    const draws = Array.from({ length: count }, drawGachaCard);
    let spinType;
    if (gachaStatus.dailyAvailable) {
        user.dailyGachaDate = new Date().toISOString().slice(0, 10);
        spinType = 'daily';
    } else {
        user.bonusGachaSpins -= 1;
        spinType = 'bonus';
    }
    user.balance -= cost;
    user.coinsSpent += cost;
    user.inventory.push(...draws.map((draw) => draw.name));
    addExperience(user, 100);
    await saveUsers();

    res.json({
        success: true,
        draws,
        cost,
        balance: user.balance,
        experience: user.experience,
        xpAwarded: 100,
        gacha: getGachaStatus(user),
        spinType,
        message: count === 1 ? `Выпала карта: ${draws[0].name}!` : `Открыто карт: ${count}.`
    });
});

app.post('/api/cases/open', async (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'Сначала войди в игру.' });
    if ((user.caseCount || 0) < 1) return res.status(400).json({ message: 'У тебя нет кейсов.' });

    const draw = drawCaseCard();
    user.caseCount -= 1;
    user.inventory.push(draw.name);
    addExperience(user, 100);
    await saveUsers();

    res.json({
        success: true,
        draw,
        caseCount: user.caseCount,
        inventory: user.inventory,
        experience: user.experience,
        xpAwarded: 100,
        message: `В кейсе выпала карта «${draw.name}» · ${draw.rarityLabel}!`
    });
});

app.post('/api/upgrade', async (req, res) => {
    const user = getCurrentUser(req);
    if (!user) return res.status(401).json({ message: 'Сначала войди в игру.' });

    const { sourceCard, targetCard } = req.body;
    const sourceRarity = cardRarities[sourceCard];
    const targetRarity = cardRarities[targetCard];
    const sourceRank = rarityRanks[sourceRarity];
    const targetRank = rarityRanks[targetRarity];

    if (!sourceRarity || !targetRarity || targetRank <= sourceRank) {
        return res.status(400).json({ message: 'Выбери карту более высокой редкости.' });
    }

    const sourceIndex = user.inventory.indexOf(sourceCard);
    if (sourceIndex === -1) return res.status(400).json({ message: 'Этой карты нет в твоём инвентаре.' });

    const chance = Math.min(90, 0.2 * (2 ** (sourceRank + 8 - targetRank)));
    const success = Math.random() * 100 < chance;
    user.inventory.splice(sourceIndex, 1);

    if (success) {
        user.inventory.push(targetCard);
        user.card = targetCard;
    } else if (user.card === sourceCard) {
        user.card = user.inventory[0] || 'Нет карты';
    }

    await saveUsers();
    res.json({
        success,
        chance,
        message: success
            ? `Успех! Карта «${sourceCard}» улучшена до «${targetCard}».`
            : `Неудача. Карта «${sourceCard}» сгорела.`,
        inventory: user.inventory,
        card: user.card
    });
});

// --- АДМИНСКИЕ МАРШРУТЫ ---
function findTargetUser(username) {
    if (typeof username !== 'string' || !username.trim()) return undefined;
    const usernameKey = normalizeUsername(username);
    return users.find((user) => normalizeUsername(user.username) === usernameKey);
}

function adminOnly(req, res) {
    const admin = getCurrentUser(req);
    if (!admin) {
        res.status(401).json({ message: 'Сначала войди в аккаунт.' });
        return false;
    }
    if (admin.role !== 'admin') {
        res.status(403).json({ message: 'Доступ запрещён.' });
        return false;
    }
    return true;
}

app.post('/api/admin/give-card', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const targetUser = findTargetUser(req.body.username);
    const cardName = typeof req.body.cardName === 'string' ? req.body.cardName.trim() : '';
    if (!targetUser) return res.status(404).json({ message: 'Игрок с таким ником не найден.' });
    if (!cardName || cardName.length > 100) return res.status(400).json({ message: 'Укажи название карты (до 100 символов).' });

    targetUser.inventory.push(cardName);
    targetUser.card = cardName;
    await saveUsers();
    res.json({ success: true, message: `Карта «${cardName}» выдана игроку ${targetUser.username}.` });
});

app.post('/api/admin/grant-coins', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const targetUser = findTargetUser(req.body.username);
    const amount = Number(req.body.amount);
    if (!targetUser) return res.status(404).json({ message: 'Игрок с таким ником не найден.' });
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        return res.status(400).json({ message: 'Количество монет должно быть целым числом больше нуля.' });
    }

    targetUser.balance += amount;
    targetUser.coinsEarned += amount;
    await saveUsers();
    res.json({ success: true, message: `Выдано ${amount} монет игроку ${targetUser.username}.`, balance: targetUser.balance });
});

app.post('/api/admin/grant-roulette', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const targetUser = findTargetUser(req.body.username);
    const spins = Number(req.body.spins);
    if (!targetUser) return res.status(404).json({ message: 'Игрок с таким ником не найден.' });
    if (!Number.isSafeInteger(spins) || spins <= 0) {
        return res.status(400).json({ message: 'Количество прокрутов должно быть целым числом больше нуля.' });
    }

    targetUser.bonusRouletteSpins += spins;
    await saveUsers();
    res.json({ success: true, message: `Выдано прокрутов: ${spins}.`, bonusRouletteSpins: targetUser.bonusRouletteSpins });
});

app.post('/api/admin/grant-cases', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const targetUser = findTargetUser(req.body.username);
    const cases = Number(req.body.cases);
    if (!targetUser) return res.status(404).json({ message: 'Игрок с таким ником не найден.' });
    if (!Number.isSafeInteger(cases) || cases <= 0) {
        return res.status(400).json({ message: 'Количество кейсов должно быть целым числом больше нуля.' });
    }

    targetUser.caseCount += cases;
    await saveUsers();
    res.json({ success: true, message: `Выдано кейсов: ${cases}.`, caseCount: targetUser.caseCount });
});

app.post('/api/admin/grant-gacha', async (req, res) => {
    if (!adminOnly(req, res)) return;
    const targetUser = findTargetUser(req.body.username);
    const spins = Number(req.body.spins);
    if (!targetUser) return res.status(404).json({ message: 'Игрок с таким ником не найден.' });
    if (!Number.isSafeInteger(spins) || spins <= 0) {
        return res.status(400).json({ message: 'Количество запусков Северо-Юга должно быть целым числом больше нуля.' });
    }

    targetUser.bonusGachaSpins += spins;
    await saveUsers();
    res.json({ success: true, message: `Выдано запусков Северо-Юга: ${spins}.`, bonusGachaSpins: targetUser.bonusGachaSpins });
});

loadUsers().then(() => {
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '0.0.0.0';
    app.listen(port, host, () => {
        console.log(`Сервер запущен! Открой в браузере: http://localhost:${port}`);
    });
}).catch((error) => {
    console.error('Не удалось загрузить пользователей:', error);
    process.exitCode = 1;
});