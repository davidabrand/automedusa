# AutoMedusa

Dealership inventory, expenses, sourcing and profit tracking. Plain HTML, CSS and
JavaScript, built with [Vite](https://vite.dev) and Tailwind CSS, with Supabase for
sign-in and the database. GitHub builds and publishes it automatically.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | All the page markup (screens, forms, dialogs) |
| `src/app.js` | All the app logic |
| `src/styles.css` | Custom styles; Tailwind classes are compiled in at build time |
| `src/main.js` | Entry point that loads the two files above |
| `public/` | Images, video, icons and the web-app manifest, copied as-is |
| `tailwind.config.js` | The Apple-style color palette and font |
| `vite.config.js` | Build settings, including the automatic version stamp |
| `.github/workflows/deploy.yml` | Builds and publishes the site on every push to `main` |
| `SUPABASE_SECURITY.md` | Database security checklist |

## Publishing (no software needed)

**One-time setup:** in the repository on GitHub go to **Settings → Pages →
Build and deployment → Source** and choose **GitHub Actions**.

After that, every change you commit to `main` (including uploads through the GitHub
website) is built and published automatically in about a minute. Watch progress in
the **Actions** tab; a green check means the new version is live.

If a build fails, the live site keeps the last working version.

## Editing on your own computer (optional)

Install [Node.js LTS](https://nodejs.org), then in this folder:

```bash
npm install
npm run dev
```

Open the address it prints. The page updates as you save files. `npm run build` makes
the same production build GitHub does, in `dist/`.

## Notes

- Never put customer data (CSVs, exports) in this repository. It's public.
  `.gitignore` already blocks `*.csv`.
- The version stamp in the page updates on every build, so phones with the app on the
  home screen reload to the newest version automatically.
- Add `?debug` to the URL to show the cloud diagnostic. It writes and deletes one
  test row in `expenses`.
