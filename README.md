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

If the egg installs dependencies independently, set its entry file to `bot.js`. Run one bot instance and keep `data/wowhelper.json` in persistent storage. This file stores signup responses, maintenance windows, and pending announcements across restarts. Each startup synchronizes the application's guild commands, so use a dedicated bot application.

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
