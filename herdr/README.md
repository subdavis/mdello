# Herdr Desktop mods

mdello's additions to [Herdr Desktop](https://herdr.dev): the `my-agents` mod (agents list with
each agent's mdello cards) and the `my-main` layout that uses it.

Edit here, never in `~/.config/herdr-app`. Herdr only hot-reloads real files in its home
(not symlinks), so `sync.mjs` copies `mods/` and `layouts/` there. Copied `.js` files get a
2-line "GENERATED, do not edit" header, so Herdr's error line numbers are 2 more than here.

```sh
yarn herdr:sync    # copy once
yarn herdr:watch   # copy on every save; Herdr reloads the open mod
herdr-app check ~/.config/herdr-app/mods/my-agents
```

Sync won't overwrite a file that changed in Herdr's home since the last sync (an agent following
Herdr's AGENTS.md edits there). It reports `CONFLICT`. Copy the change back here, or use
`--force` to discard it. Files deleted here aren't deleted there.

## Herdr updates

Herdr never updates the clones. `upstream/` holds the shipped files they were cloned from (version in
`upstream/VERSION`). After a Herdr update:

```sh
H=~/.config/herdr-app
# 1. Merge upstream changes into the mod (conflicts get markers)
git merge-file mods/my-agents/main.js upstream/agents/main.js $H/mods/agents/main.js
# 2. Rebuild the layout: shipped main with the agents block pointed at my-agents
jq '(.. | objects | select(.content?.mod=="agents") | .content.mod) = "my-agents"
    | .cloned_from = {name: "main", version: "<new version>"}' $H/layouts/main.json > layouts/my-main.json
# 3. Refresh the base snapshot
cp $H/mods/agents/{main.js,mod.json} upstream/agents/ && cp $H/layouts/main.json upstream/
herdr-app --version | cut -d' ' -f2 > upstream/VERSION
yarn herdr:sync && herdr-app check $H/mods/my-agents
```

The sort popup in `main.js` opens `mod: "my-agents"`, not `"agents"`. Keep that through merges.
