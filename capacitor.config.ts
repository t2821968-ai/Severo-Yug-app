import type { CapacitorConfig } from '@capacitor/cli';

const gameUrl = process.env.GAME_URL;

const config: CapacitorConfig = {
    appId: 'com.severoyug.game',
    appName: 'Северо-Юг',
    webDir: 'public',
    ...(gameUrl ? { server: { url: gameUrl, cleartext: false } } : {})
};

export default config;