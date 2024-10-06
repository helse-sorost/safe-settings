# Startup

- When calling `npm start`, [Probot will call your entrypoint](https://probot.github.io/docs/hello-world/), i.e. the bootstrap function exported from [index.js](../index.js)
- This function recieves an instance of the `Probot` class (the other params are for special cases)
  - Note-to-self: look into what Probot actually offers of default test stuff.
- There are three ways to start work:
  1. At the end of the boostrap function, `syncInstallation` is called.
  2. The boostrap function sets up a cron job (if the correct environment variable is set) that calls `syncInstallation`.
  3. The boostrap function adds event listeners to different webhook events from GitHub (exposed by Probot).
- `syncInstallation` calls `syncAllSettings`, as long as there is at least one installation of the app.
- The event listeners contains logic to _determine what was changed in GitHub_, and based on this calls one (or more? I don't think so...) of the `*sync*`-methods (e.g. `syncAllSettings`, `syncSubOrgSettings`, `syncSettings` or `renameSync `)
  > Note-to-self: the [Performance](https://github.com/github/safe-settings?tab=readme-ov-file#performance)-considerations might be the reason, but it feels like a bug that if a repo-config is changed this does not seem to call `syncSubOrgSettings`. \
  > **TODO:** Test changing repo and suborg config in the same PR!
- The end result is that if there are changes in GitHub (changed settings-files in the admin-repo or changed actual settings), the methods `sync`, `syncSubOrgs` and `syncAll` in [settings.js](../lib/settings.js) will be called and do some more setup to do the actual updating.
- The end result is that `updateRepos` in [settings.js](../lib/settings.js) will be called (if you update the main settings file, this might also call `updateOrg`, that handles the org level config). Finally, `handleResults` will be called (this is the "information" part of the whole run)

# The actual magic

> What happens in `updateRepos`?

- First, we create the merged config that applies to this repository
- Then, we figure out which `Plugins` that are part of the config for this repo
- If there is a specific `repoConfig`, we first apply the `repository`-plugin
- Finally, we apply all the plugins that should be applied for this repo

# On workflows

- `node-ci` runs on all PRs
- `rc-release` runs on PRs labeled `stage`
- `create-pre-release` and `create-release` are run manually

I guess the one I want to redo first for my fork is `create-release`.

Probably, I can simplify a lot based on [deploy-ingress.yaml](https://github.com/SPHF-Moderne-Tjenesteutvikling/butikken/blob/main/.github/workflows/deploy-ingress.yaml) from Gnist.
