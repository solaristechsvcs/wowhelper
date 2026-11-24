export default {
  token: 'YOUR_DISCORD_BOT_TOKEN',
  guildId: 'YOUR_DISCORD_SERVER_ID',
  officerRoleId: '',
  maintenanceChannelId: '',
  blizzard: {
    clientId: '',
    clientSecret: '',
    realms: [
      // { region: 'us', edition: 'retail', id: 0, label: 'My realm group' },
    ],
  },
  updater: {
    enabled: true,
    repository: 'https://github.com/solaristechsvcs/wowhelper.git',
    branch: 'main',
    intervalSeconds: 300,
    startupTimeoutSeconds: 60,
  },
  dataFile: './data/wowhelper.json',
};
