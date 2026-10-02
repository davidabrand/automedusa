import { defineConfig } from 'vite';

// Stamped into <meta name="automedusa-version"> on every build. The app compares it
// with the live page and reloads itself, so home-screen copies never go stale.
// Computed once per run so the dev server doesn't report a new version on every request.
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const APP_VERSION = `${now.getUTCFullYear()}.${pad(now.getUTCMonth() + 1)}.${pad(now.getUTCDate())}.${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;

export default defineConfig({
    // Relative asset paths, so the site works at https://<user>.github.io/<repo>/
    // whatever the repository is called.
    base: './',
    plugins: [{
        name: 'automedusa-version',
        transformIndexHtml: html => html.replace('__APP_VERSION__', APP_VERSION)
    }],
    build: {
        outDir: 'dist',
        emptyOutDir: true
    }
});
