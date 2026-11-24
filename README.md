# WoWHelper

WoWHelper is a Discord bot for a World of Warcraft guild. It handles raid RSVPs and maintenance announcements for Retail, Classic, or any edition and region your guild plays.

## Discord setup

1. Create a dedicated application in the [Discord Developer Portal](https://discord.com/developers/applications) and obtain its bot token.
2. Under Installation, enable Guild Install and select the `bot` and `applications.commands` scopes. Install the app on your guild's Discord server.
3. Give the bot View Channel, Send Messages, Embed Links, and Read Message History in raid channels. Give it View Channel and Send Messages in your maintenance channel. The bot uses the standard Guilds intent.
4. Copy `config.example.js` to `config.js`. Set `token`, `guildId`, and `maintenanceChannelId`. To let officers manage events without Manage Server, set `officerRoleId` to their Discord role ID. Keep the token private.

## Wisp startup

Use a Node.js 22.12+ or 24 egg. Put the repository files and your `config.js` in the server root.

```sh
npm install --omit=dev && npm start
```

If the egg installs dependencies independently, set its entry file to `scripts/start.js`. The updater needs Git, npm, and outbound access to GitHub and the npm registry. Run one bot instance and keep `data/wowhelper.json` in persistent storage. This file stores signup responses, maintenance windows, and pending announcements across restarts. Each startup synchronizes the application's guild commands, so use a dedicated bot application.

### Automatic updates

The updater checks the public WoWHelper repository's `main` branch every five minutes by default. It stages new code and installs its dependencies in `.wowhelper-updates/` before restarting the bot. A release becomes active after Discord login and command registration succeed. If startup fails, the updater restarts the previous release.

Keep `config.js` and the data file in the Wisp server root. Relative `dataFile` paths are resolved from that root under the updater. For an existing deployment, install this version once and change the Wisp entry point from `bot.js` to `scripts/start.js` or use the command above.

Set `updater.enabled` to `false` to stop polling and continue using the last active release. Use `npm run start:direct` to run the installed server-root version without the updater.

## Raid commands

| Command | Use |
| --- | --- |
| `/raid create` | Post a raid in the current channel. |
| `/raid upcoming` | See the next ten raids with links. |
| `/raid roster` | View all RSVPs grouped by role. |
| `/raid close` | Close a raid's signups early. |

Each member can change their RSVP by pressing another button. Signups stop at raid start. Raid times render in each member's local timezone.

## Maintenance alerts

Use `/maintenance schedule` with an edition and region such as `Retail NA`, plus a start and end time. Enter timestamps with explicit timezone offsets, such as `2027-01-12T10:00-05:00` or `2027-01-12T15:00Z`. Raid times use the same format.

WoWHelper posts the scheduled announcement immediately, then posts start and end updates based on the supplied timestamps. It checks every 15 seconds while online and catches up on pending notices after a restart. Time-based announcements carry a scheduled-time label. An officer can use `/maintenance start` or `/maintenance end` with the posted ID to confirm actual status, including an early finish. Enter dates from the [Blizzard Support maintenance bulletin](https://us.support.blizzard.com/en/help/product/wow/2).

### Automatic Blizzard realm status

1. Create a client in the [Battle.net Developer Portal](https://develop.battle.net/access/clients). Add its client ID and secret to the `blizzard` block in your private `config.js`.
2. Add each realm group to `blizzard.realms` with a label, region (`us`, `eu`, `kr`, or `tw`), edition (`retail`, `classic`, or `era`), and numeric **connected-realm ID**. To locate the ID, query `/data/wow/realm/{slug}` using an OAuth token and the edition's dynamic namespace. Read the ID in the returned `connected_realm.href`. Some Classic environments may differ in API coverage.
3. Set `maintenanceChannelId` and restart. Check `/maintenance status` for each realm's last successful reading.

The bot polls Blizzard every two minutes and posts when a realm changes from online to offline or back. The first successful reading establishes a baseline. Failed API calls preserve the last valid result. Realm status reports availability, and scheduled announcements still use the times entered with `/maintenance schedule`.

## Wowhead search

Choose Retail, Classic, or Forever in the required `edition` field, then enter a search term in `query`. For example, `/wowhead edition:Forever query:Thunderfury` shows a private Discord embed with direct links and result types. Results are displayed five at a time with Previous and Next controls when more pages are available. The Wowhead button opens the full search and is also available if in-Discord results cannot be loaded. Use item, quest, NPC, spell, or guide names as keywords.
