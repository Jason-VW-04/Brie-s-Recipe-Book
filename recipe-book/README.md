# Recipe Book

Your online recipe book. It runs entirely in the browser: recipes, pictures, tags and the grocery list are saved on the device you use it on. Nothing is uploaded anywhere.

## Put it on GitHub (about 5 minutes, on a computer)

1. Sign in at github.com (or make a free account).
2. Click **+** in the top right, then **New repository**. Name it `recipe-book`, leave it **Public**, and click **Create repository**.
3. On the next page click **uploading an existing file**. Open this folder on your computer, select everything inside it (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, and the `fonts`, `icons` and `extras` folders) and drag it all onto the page. Click **Commit changes**.
4. Go to the repository's **Settings**, then **Pages** in the left menu. Under **Build and deployment**, set **Source** to "Deploy from a branch", choose the **main** branch and the **/ (root)** folder, and click **Save**.
5. Wait a minute or two, then open `https://YOUR-USERNAME.github.io/recipe-book/`.

The repository has to be public for free GitHub Pages. That only makes the app's code public. Your recipes are never in the repository.

## Put it on your iPhone

1. Open your address from step 5 in **Safari**.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.

It now opens full screen like any other app, and works without a connection.

**Add your recipes in the Home Screen app, not in Safari.** On an iPhone the Home Screen app keeps its own separate storage, so recipes added in Safari do not show up in the app.

## Keeping your recipes safe

Everything lives on the phone. Deleting the app from the Home Screen, or clearing website data, deletes the recipes with it. Every so often open **Tags**, scroll to **Your book** and tap **Save a backup file**. Keep that file in Files or iCloud Drive. **Restore from a backup file** brings everything back, and is also how you move the book to another phone.

## Importing from a link

GitHub can only serve the page itself, so to read a recipe from another website the app asks a free public relay service to fetch that page. This works for most recipe sites, but those services are run by volunteers and some sites block them. When a link will not import, the app offers **paste the recipe text instead**: copy the recipe from the page, paste it in, and it sorts out the ingredients and steps.

If link import becomes unreliable, you can run your own relay for free:

1. Make a free account at cloudflare.com and create a **Worker**.
2. Replace its code with the contents of `extras/import-helper-worker.js`, changing `YOUR-USERNAME` on the line near the top to your GitHub username. Deploy it.
3. Copy the Worker's address (it ends in `workers.dev`), and in the app open **Tags**, scroll to **Link import helper**, and paste it there.

## Changing the app later

Upload the changed files to the same repository (**Add file**, **Upload files**). The app picks up the new version the second time you open it.
