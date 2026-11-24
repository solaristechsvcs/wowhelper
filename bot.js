import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, ComponentType, Events, GatewayIntentBits,
  MessageFlags, PermissionFlagsBits, SlashCommandBuilder, escapeMarkdown,
} from 'discord.js';
import { searchWowhead } from './wowhead.js';
import { pathToFileURL } from 'node:url';
import { blizzardClient, observeRealm, realmKey, validateBlizzard } from './blizzard.js';
import { advanceMaintenance, openState, parseTime, transition } from './state.js';

const configUrl = process.env.WOWHELPER_CONFIG_PATH
  ? pathToFileURL(process.env.WOWHELPER_CONFIG_PATH)
  : new URL('./config.js', import.meta.url);
const { default: config } = await import(configUrl.href);

const isId = value => /^\d{17,20}$/.test(value);
if (!config.token || config.token === 'YOUR_DISCORD_BOT_TOKEN' || !isId(config.guildId)) {
  throw new Error('Set token and guildId in config.js.');
}
for (const key of ['officerRoleId', 'maintenanceChannelId']) {
  if (config[key] && !isId(config[key])) throw new Error('Invalid ' + key + ' in config.js.');
}

validateBlizzard(config.blizzard);
const watchedRealms = config.blizzard?.realms ?? [];
if (watchedRealms.length && !config.maintenanceChannelId) {
  throw new Error('Set maintenanceChannelId to enable Blizzard realm monitoring.');
}
const blizzard = blizzardClient(config.blizzard);
const db = openState(config.dataFile);
const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
const roles = { tank: 'Tank', healer: 'Healer', dps: 'DPS', tentative: 'Tentative', absent: 'Absent' };
const timeFormat = 'YYYY-MM-DDTHH:mmZ or YYYY-MM-DDTHH:mm-05:00';
const stamp = (at, format = 'F') => '<t:' + Math.floor(at / 1000) + ':' + format + '>';
const opt = (command, name, description, max = 100) => command.addStringOption(
  option => option.setName(name).setDescription(description).setRequired(true).setMaxLength(max),
);
const wowheadEditions = {
  retail: { name: 'Retail', path: '/search' },
  classic: { name: 'Classic', path: '/classic/search' },
  forever: { name: 'Forever', path: '/forever/search' },
};
const wowheadCommand = new SlashCommandBuilder().setName('wowhead')
  .setDescription('Search Wowhead for items, quests, spells, and more');
wowheadCommand.addStringOption(option => option.setName('edition')
  .setDescription('Choose Retail, Classic, or Forever').setRequired(true)
  .addChoices(Object.entries(wowheadEditions).map(([value, edition]) => ({ name: edition.name, value }))));
opt(wowheadCommand, 'query', 'What to look up');

const armoryRegions = { us: 'North America', eu: 'Europe', kr: 'Korea', tw: 'Taiwan' };
const armoryCommand = new SlashCommandBuilder().setName('armory')
  .setDescription('Look up a Retail WoW character on the Blizzard Armory')
  .addStringOption(option => option.setName('region').setDescription('Character region').setRequired(true)
    .addChoices(Object.entries(armoryRegions).map(([value, name]) => ({ name, value }))));
opt(armoryCommand, 'realm', 'Realm name or Armory realm slug');
opt(armoryCommand, 'character', 'Character name', 32);

const commands = [
  armoryCommand,
  wowheadCommand,
  new SlashCommandBuilder().setName('raid').setDescription('Plan and sign up for guild raids')
    .addSubcommand(command => {
      command.setName('create').setDescription('Post a raid signup in this channel');
      opt(command, 'title', 'Raid name');
      return opt(command, 'start', timeFormat);
    })
    .addSubcommand(command => command.setName('upcoming').setDescription('Show the next ten raids'))
    .addSubcommand(command => opt(command.setName('roster').setDescription('Show all signups by role'), 'id', 'Raid ID'))
    .addSubcommand(command => opt(command.setName('close').setDescription('Close raid signups'), 'id', 'Raid ID')),
  new SlashCommandBuilder().setName('maintenance').setDescription('Manage WoW maintenance alerts')
    .addSubcommand(command => {
      command.setName('schedule').setDescription('Announce and schedule a maintenance window');
      opt(command, 'edition', 'WoW edition and region, such as Retail NA');
      opt(command, 'start', timeFormat);
      return opt(command, 'end', timeFormat);
    })
    .addSubcommand(command => command.setName('status').setDescription('Show the latest checks from Blizzard'))
    .addSubcommand(command => opt(command.setName('start').setDescription('Confirm maintenance has started'), 'id', 'Maintenance ID'))
    .addSubcommand(command => opt(command.setName('end').setDescription('Confirm maintenance has ended'), 'id', 'Maintenance ID')),
];

const officer = interaction =>
  interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
  Boolean(config.officerRoleId && interaction.member?.roles.cache.has(config.officerRoleId));

const privateReply = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

async function handleWowhead(interaction) {
  const query = interaction.options.getString('query', true).trim();
  if (!query) return privateReply(interaction, 'Enter an item, quest, spell, or other search term.');

  const editionKey = interaction.options.getString('edition');
  if (!Object.hasOwn(wowheadEditions, editionKey)) {
    return privateReply(interaction, 'Choose Retail, Classic, or Forever before searching.');
  }
  const edition = wowheadEditions[editionKey];
  const url = new URL(edition.path, 'https://www.wowhead.com');
  url.searchParams.set('q', query);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const site = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Wowhead').setURL(url.href);
  let results;
  try {
    results = await searchWowhead(url, query);
  } catch (error) {
    console.error('Wowhead search failed:', error.message);
    return interaction.editReply({
      content: 'Wowhead results are temporarily unavailable in Discord. Open the search on Wowhead below.',
      components: [new ActionRowBuilder().addComponents(site)],
    });
  }

  const size = 5;
  const pages = Math.max(1, Math.ceil(results.length / size));
  let page = 0;
  function card(expired = false) {
    const first = page * size;
    const description = results.slice(first, first + size).map((result, index) =>
      '**' + (first + index + 1) + '. [' + escapeMarkdown(result.title) + '](' + result.url + ')**\n' + result.type,
    ).join('\n\n');
    const row = new ActionRowBuilder();
    if (pages > 1) {
      row.addComponents(
        new ButtonBuilder().setCustomId('wowhead:prev').setLabel('Previous')
          .setStyle(ButtonStyle.Secondary).setDisabled(expired || page === 0),
        new ButtonBuilder().setCustomId('wowhead:next').setLabel('Next')
          .setStyle(ButtonStyle.Primary).setDisabled(expired || page === pages - 1),
      );
    }
    return {
      embeds: [{
        title: 'Wowhead ' + edition.name + ' results',
        url: url.href,
        color: 0xba8d35,
        description: description || 'No results could be displayed. Use the Wowhead button to check the full search.',
        footer: { text: query + ' · ' + results.length + ' shown in Discord · Page ' + (page + 1) + '/' + pages },
      }],
      components: [row.addComponents(site)],
    };
  }

  const message = await interaction.editReply(card());
  if (pages === 1) return;
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 120_000,
    filter: button => button.user.id === interaction.user.id &&
      ['wowhead:prev', 'wowhead:next'].includes(button.customId),
  });
  collector.on('collect', button => {
    page = button.customId === 'wowhead:next' ? Math.min(pages - 1, page + 1) : Math.max(0, page - 1);
    void button.update(card()).catch(error => console.error('Wowhead page update failed:', error.message));
  });
  collector.on('end', () => { void interaction.editReply(card(true)).catch(() => {}); });
}

async function handleArmory(interaction) {
  if (!config.blizzard?.clientId || !config.blizzard?.clientSecret) {
    return privateReply(interaction, 'Armory lookup requires Blizzard API credentials in config.js.');
  }
  const region = interaction.options.getString('region', true);
  const realm = interaction.options.getString('realm', true).trim().normalize('NFC')
    .toLowerCase().replace(/['’]/g, '').replace(/\s+/g, '-');
  const name = interaction.options.getString('character', true).trim().normalize('NFC').toLowerCase();
  if (!Object.hasOwn(armoryRegions, region) || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(realm) ||
      !/^\p{L}[\p{L}\p{M}]*$/u.test(name)) {
    return privateReply(interaction, 'Enter a valid region, realm name or slug, and character name.');
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let profile;
  try {
    profile = await blizzard.character(region, realm, name);
  } catch (error) {
    console.error('Armory lookup failed:', error.message);
    return interaction.editReply('Blizzard’s character API is unavailable right now. Try again later.');
  }
  if (!profile) {
    return interaction.editReply('No public Retail profile was found. Check the region, realm slug, and spelling.');
  }

  const locales = { us: 'en-us', eu: 'en-gb', kr: 'ko-kr', tw: 'zh-tw' };
  const armory = 'https://worldofwarcraft.blizzard.com/' + locales[region] + '/character/' +
    [region, profile.realm?.slug || realm, name].map(encodeURIComponent).join('/');
  const fields = [
    ['Level', profile.level],
    ['Class', profile.character_class?.name],
    ['Race', profile.race?.name],
    ['Specialization', profile.active_spec?.name],
    ['Faction', profile.faction?.name],
    ['Guild', profile.guild?.name],
    ['Equipped item level', profile.equipped_item_level],
    ['Achievement points', profile.achievement_points],
  ].filter(([, value]) => typeof value === 'string' && value.trim() || Number.isFinite(value))
    .map(([name, value]) => ({ name, value: escapeMarkdown(String(value)).slice(0, 1024), inline: true }));
  return interaction.editReply({
    embeds: [{
      title: escapeMarkdown(profile.name).slice(0, 256),
      description: escapeMarkdown(profile.realm?.name || realm) + ' · ' + armoryRegions[region] + ' · Retail',
      color: 0xba8d35,
      url: armory,
      fields,
    }],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open Blizzard Armory').setURL(armory),
    )],
  });
}

function raidCard(raid) {
  const closed = raid.closed || Date.now() >= raid.start;
  const responses = Object.values(raid.responses);
  return {
    embeds: [{
      title: raid.title,
      color: 0xba8d35,
      description: stamp(raid.start) + ' (' + stamp(raid.start, 'R') + ')',
      fields: Object.entries(roles).map(([key, label]) => ({
        name: label, value: String(responses.filter(role => role === key).length), inline: true,
      })),
      footer: { text: 'Raid ID ' + raid.id + (closed ? ' · Signups closed' : '') },
    }],
    components: [new ActionRowBuilder().addComponents(
      Object.entries(roles).map(([key, label]) => new ButtonBuilder()
        .setCustomId('raid:' + raid.id + ':' + key).setLabel(label)
        .setStyle(key === 'absent' ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(closed)),
    )],
  };
}

const raidEdits = new Map();
function refreshRaid(raid) {
  const previous = raidEdits.get(raid.id) ?? Promise.resolve();
  const edit = previous.catch(() => {}).then(async () => {
    const channel = await client.channels.fetch(raid.channelId);
    await channel.messages.edit(raid.messageId, raidCard(db.current.raids[raid.id]));
  });
  raidEdits.set(raid.id, edit);
  return edit.finally(() => {
    if (raidEdits.get(raid.id) === edit) raidEdits.delete(raid.id);
  });
}

async function handleRaid(interaction, action) {
  const field = name => interaction.options.getString(name, true).trim();
  if (action === 'create') {
    if (!officer(interaction)) return privateReply(interaction, 'Only raid officers can post raids.');
    const start = parseTime(field('start'));
    const title = field('title');
    if (!title || start === null || start <= Date.now()) {
      return privateReply(interaction, 'Enter a title and a future start time using ' + timeFormat + '.');
    }
    const raid = { id: interaction.id, title, start, responses: {}, closed: false, channelId: interaction.channelId };
    await interaction.deferReply();
    const draft = await interaction.fetchReply();
    raid.messageId = draft.id;
    db.update(data => { data.raids[raid.id] = raid; });
    await interaction.editReply(raidCard(raid));
    return;
  }

  if (action === 'upcoming') {
    const raids = Object.values(db.current.raids).filter(raid => raid.start > Date.now())
      .sort((first, second) => first.start - second.start).slice(0, 10);
    const lines = raids.map(raid => stamp(raid.start, 'f') + ' · ' + escapeMarkdown(raid.title) +
      ' · [Signup post](https://discord.com/channels/' + config.guildId + '/' + raid.channelId + '/' + raid.messageId + ')');
    return interaction.reply({ embeds: [{ title: 'Upcoming raids', description: lines.join('\n') || 'No upcoming raids.' }] });
  }

  const id = field('id');
  const raid = isId(id) ? db.current.raids[id] : null;
  if (!raid) return privateReply(interaction, 'Raid ID not found.');

  if (action === 'roster') {
    const members = Object.entries(raid.responses);
    const lines = Object.entries(roles).flatMap(([key, label]) => [
      label + ' (' + members.filter(([, role]) => role === key).length + ')',
      ...members.filter(([, role]) => role === key).map(([userId]) => '<@' + userId + '>'),
      '',
    ]);
    const chunks = [];
    let chunk = '';
    for (const line of lines) {
      if (chunk.length + line.length > 1750) {
        chunks.push(chunk);
        chunk = '';
      }
      chunk += line + '\n';
    }
    chunks.push(chunk);
    await privateReply(interaction, chunks.shift());
    for (const content of chunks) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    return;
  }

  if (!officer(interaction)) return privateReply(interaction, 'Only raid officers can close signups.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  db.update(data => { data.raids[id].closed = true; });
  await updateCard(interaction, raid, 'Raid signups closed.');
}

async function updateCard(interaction, raid, confirmation) {
  try {
    await refreshRaid(raid);
  } catch (error) {
    console.error('Raid post refresh failed:', error.message);
    return interaction.editReply(confirmation + ' The signup post could not be refreshed.');
  }
  return interaction.editReply(confirmation);
}

async function handleSignup(interaction) {
  const [, id, role] = interaction.customId.split(':');
  if (!isId(id) || !Object.hasOwn(roles, role)) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const raid = db.current.raids[id];
  if (!raid || raid.messageId !== interaction.message.id || raid.closed || raid.start <= Date.now()) {
    return interaction.editReply('Signups are closed.');
  }
  db.update(data => { data.raids[id].responses[interaction.user.id] = role; });
  return updateCard(interaction, raid, 'Your signup is set to ' + roles[role] + '.');
}

async function maintenanceChannel() {
  const channel = await client.channels.fetch(config.maintenanceChannelId);
  if (channel?.guildId !== config.guildId || !channel.isSendable()) {
    throw new Error('Configure a sendable maintenance channel in this server.');
  }
  const permissions = channel.permissionsFor(client.user);
  const send = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, send])) {
    throw new Error('The bot needs View Channel and permission to send messages in the maintenance channel.');
  }
  return channel;
}

let sending = false;
async function sendMaintenanceNotices() {
  if (sending || !config.maintenanceChannelId) return;
  sending = true;
  try {
    const now = Date.now();
    if (Object.values(db.current.maintenance).some(window =>
      (window.status === 'scheduled' && window.start <= now) ||
      (window.status === 'started' && window.end <= now))) {
      db.update(data => advanceMaintenance(data, now));
    }
    if (!db.current.notices.length) return;
    const channel = await maintenanceChannel();
    while (db.current.notices.length) {
      const notice = db.current.notices[0];
      if (notice.kind === 'realm') {
        await channel.send({
          content: '**' + (notice.status === 'UP' ? 'Realm back online' : 'Realm went offline') +
            '** · ' + escapeMarkdown(notice.label) + '\nBlizzard realm status · ' + stamp(notice.at),
          nonce: notice.nonce,
          enforceNonce: true,
        });
        db.update(data => { data.notices.shift(); });
        continue;
      }
      const window = db.current.maintenance[notice.id];
      const title = notice.status === 'scheduled' ? 'Maintenance scheduled'
        : 'Maintenance ' + notice.status + (notice.confirmed ? ' · officer confirmed' : ' · scheduled time');
      const details = notice.status === 'scheduled'
        ? stamp(window.start) + ' to ' + stamp(window.end)
        : stamp(notice.at);
      await channel.send({
        content: '**' + title + '** · ' + escapeMarkdown(window.edition) +
          '\n' + details + '\nMaintenance ID: `' + window.id + '`',
        nonce: window.id + { scheduled: 'q', started: 's', ended: 'e' }[notice.status] + Number(notice.confirmed),
        enforceNonce: true,
      });
      db.update(data => { data.notices.shift(); });
    }
  } catch (error) {
    console.error('Maintenance notice delivery failed:', error.message);
  } finally {
    sending = false;
  }
}

let polling = false;
async function pollBlizzard() {
  if (polling) return;
  polling = true;
  try {
    for (const realm of watchedRealms) {
      try {
        const status = await blizzard.status(realm);
        db.update(data => observeRealm(data, realm, status, Date.now()));
      } catch (error) {
        console.error('Blizzard check failed for ' + realmKey(realm) + ':', error.message);
      }
    }
    void sendMaintenanceNotices();
  } finally {
    polling = false;
  }
}

async function handleMaintenance(interaction, action) {
  if (action === 'status') {
    if (!watchedRealms.length) return privateReply(interaction, 'Blizzard realm monitoring is disabled.');
    const lines = watchedRealms.map(realm => {
      const result = db.current.realmStatus?.[realmKey(realm)];
      return escapeMarkdown(realm.label) + ' · ' + (result
        ? (result.status === 'UP' ? 'Online' : 'Offline') + ' · checked ' + stamp(result.checkedAt, 'R')
        : 'Waiting for a successful check');
    });
    let page = '';
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    for (const line of lines) {
      if (page.length + line.length > 1800) {
        await interaction.followUp({ content: page, flags: MessageFlags.Ephemeral });
        page = '';
      }
      page += line + '\n';
    }
    return interaction.editReply(page);
  }
  if (!officer(interaction)) return privateReply(interaction, 'Only officers can manage maintenance alerts.');
  if (!config.maintenanceChannelId) return privateReply(interaction, 'Set maintenanceChannelId in config.js first.');
  const field = name => interaction.options.getString(name, true).trim();
  if (action === 'schedule') {
    const start = parseTime(field('start'));
    const end = parseTime(field('end'));
    const edition = field('edition');
    if (!edition || start === null || end === null || start <= Date.now() || end <= start) {
      return privateReply(interaction, 'Enter an edition and a future window with the end after the start. Use ' + timeFormat + '.');
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await maintenanceChannel();
    } catch (error) {
      return interaction.editReply(error.message);
    }
    db.update(data => {
      const window = { id: interaction.id, edition, start, end };
      data.maintenance[window.id] = window;
      transition(data, window, 'scheduled', Date.now(), true);
    });
    void sendMaintenanceNotices();
    return interaction.editReply('Maintenance saved and announcement queued. ID: `' + interaction.id + '`');
  }

  const id = field('id');
  const window = isId(id) ? db.current.maintenance[id] : null;
  const allowed = action === 'start' ? ['scheduled', 'started'] : ['started', 'ended'];
  if (!window || !allowed.includes(window.status) || window[action + 'Confirmed']) {
    return privateReply(interaction, 'That maintenance window cannot be confirmed at this stage.');
  }
  db.update(data => {
    const saved = data.maintenance[id];
    saved[action + 'Confirmed'] = true;
    transition(data, saved, action === 'start' ? 'started' : 'ended', Date.now(), true);
  });
  void sendMaintenanceNotices();
  return privateReply(interaction, 'Maintenance status saved and announcement queued.');
}

client.once(Events.ClientReady, async ready => {
  try {
    await ready.application.commands.set(commands.map(command => command.toJSON()), config.guildId);
    console.log('WoWHelper online as ' + ready.user.tag);
    if (process.connected) process.send({ type: 'ready' });
    void sendMaintenanceNotices();
    setInterval(sendMaintenanceNotices, 15_000);
    if (watchedRealms.length) {
      void pollBlizzard();
      setInterval(pollBlizzard, 120_000);
    }
  } catch (error) {
    console.error('Command registration failed:', error.message);
    ready.destroy();
    process.exitCode = 1;
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.guildId !== config.guildId) return;
  try {
    if (interaction.isButton() && interaction.customId.startsWith('raid:')) {
      await handleSignup(interaction);
    } else if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'armory') {
        await handleArmory(interaction);
        return;
      }
      if (interaction.commandName === 'wowhead') {
        await handleWowhead(interaction);
        return;
      }
      const action = interaction.options.getSubcommand(false);
      if (interaction.commandName === 'raid') await handleRaid(interaction, action);
      if (interaction.commandName === 'maintenance') await handleMaintenance(interaction, action);
    }
  } catch (error) {
    console.error('Interaction failed:', error.message);
    const message = 'WoWHelper could not complete this action.';
    const reply = interaction.deferred && !interaction.replied
      ? interaction.editReply(message)
      : interaction.replied ? interaction.followUp({ content: message, flags: MessageFlags.Ephemeral })
        : privateReply(interaction, message);
    await reply.catch(() => {});
  }
});

client.login(config.token).catch(error => {
  console.error('Discord login failed:', error.code ?? error.name);
  client.destroy();
  process.exitCode = 1;
});
