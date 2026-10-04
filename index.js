import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { DateTime } from "luxon";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import { google } from "googleapis";

const DEPARTMENT = "Department of Homeland Security";
const DEPARTMENT_SHORT = "DHS";
const TRAINING_GUILD_ID = "1556355219020062850";
const TRAINING_TZ = process.env.TRAINING_TIMEZONE || "Europe/London";

// Roles supplied for the DHS server.
const JOIN_ROLE_IDS = ["1556355219225444402", "1556355219225444399"];
const DHS_ROLE_IDS = {
  chiefOfStaffPreCommand: "1556355219330441275",
  highCommand: "1556355219414319108",
  lowCommand: "1556355219263197233",
  supervisor: "1556355219263197226",
  fta: "1556355219233968203"
};

// /onboard does not blindly add server-wide roles. Join roles are handled on guildMemberAdd.
const AUTO_ONBOARD_ROLE_IDS = [];

const COLORS = {
  black: 0x0b0b0b,
  red: 0xe74c3c,
  green: 0x2ecc71,
  blue: 0x3498db,
  gold: 0xf1c40f,
  purple: 0x8e44ad
};

const STATUS = [
  "Active", "Semi-Active", "Inactive", "Suspended", "LOA", "Vacant", "Reserve",
  "Terminated", "Resigned", "Management", "Exempt", "Handpicked To DHS", "Handpicked to SP"
];

const LOG_TYPES = {
  removal: {label: "Removal", key: "removal"},
  demotion: {label: "Demotion", key: "demotion"},
  transfer: {label: "Transfer", key: "transfer"},
  task: {label: "Task", key: "task"},
  inactivity: {label: "Inactivity Warning", key: "inactivity"},
  loa: {label: "LOA", key: "loa"},
  supervisorInterview: {label: "Supervisor Interview", key: "supervisorInterview"},
  ftaInterview: {label: "FTA Interview", key: "ftaInterview"},
  training: {label: "Training", key: "training"},
  promotion: {label: "Promotion", key: "promotion"}
};

const C = {
  spreadsheetId: process.env.GOOGLE_SHEET_ID,
  rosterSheet: process.env.PERSONNEL_ROSTER_SHEET_NAME || "Personnel Roster",
  databaseSheet: process.env.PERSONNEL_DATABASE_SHEET_NAME || "Personnel Database",
  personnelStartRow: Number(process.env.PERSONNEL_DATA_START_ROW || 2),
  rosterRankCol: "B",
  rosterCallsignCol: "F",
  rosterBadgeCol: "G",
  dbBadgeCol: "B",
  dbRpNameCol: process.env.PERSONNEL_DATABASE_RP_NAME_COL || "D",
  dbJoinDateCol: "F",
  dbPromotionDateCol: "G",
  dbDiscordIdCol: "I",
  dbStatusCol: "K",
  dbStrike1Col: "M",
  dbStrike2Col: "N",
  dbTerminationCol: "O",
  dbResignedCol: "P",
  dbLoaCol: "Q",
  dbRankLockedCol: "R"
};

const DATA_DIR = path.resolve(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const TRAININGS_FILE = path.join(DATA_DIR, "trainings.json");

let settings = { guilds: {} };
let trainings = {};
const timers = new Map();

await fs.mkdir(DATA_DIR, { recursive: true });
try { settings = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8")); } catch {}
try { trainings = JSON.parse(await fs.readFile(TRAININGS_FILE, "utf8")); } catch {}
settings.guilds ||= {};

async function saveSettings() { await fs.writeFile(CONFIG_FILE, JSON.stringify(settings, null, 2)); }
async function saveTrainings() { await fs.writeFile(TRAININGS_FILE, JSON.stringify(trainings, null, 2)); }
function guildSettings(guildId) {
  settings.guilds[guildId] ||= { logRoleId: "", auditChannelId: "", promotionChannelId: "", logChannels: {}, ftoRoleId: "", commandPermissions: {}, training: { cadetChannelId: "", ftoChannelId: "", infoChannelId: "", cadetRoleId: "", ftoRoleId: "", ftaRoleId: DHS_ROLE_IDS.fta } };
  settings.guilds[guildId].training ||= { cadetChannelId: "", ftoChannelId: "", infoChannelId: "", cadetRoleId: "", ftoRoleId: "", ftaRoleId: DHS_ROLE_IDS.fta };
  settings.guilds[guildId].commandPermissions ||= {};
  settings.guilds[guildId].logChannels ||= {};
  return settings.guilds[guildId];
}

function colNum(col) { let n = 0; for (const ch of col) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
function cell(row, col) { return row?.[colNum(col) - 1] ?? ""; }
function clean(v) { return String(v ?? "").trim(); }
function isTrue(v) { return ["true", "1", "yes", "y", "checked"].includes(clean(v).toLowerCase()); }
function today() { return DateTime.now().setZone(TRAINING_TZ).toFormat("yyyy-MM-dd"); }
function stamp() { return DateTime.now().setZone(TRAINING_TZ).toISO(); }
function safeText(v) { return clean(v).slice(0, 1000) || "—"; }

function withTimeout(promise, ms = 15000, label = "operation") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s.`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function normalizeName(name) {
  return clean(name)
    .toLowerCase()
    .replace(/wcrp|san\s*andreas\s*state\s*marshals|state\s*marshals|ms/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
function tokens(name) { return normalizeName(name).split(" ").filter(Boolean); }

function normalizeRoleName(name) {
  return clean(name).toLowerCase().replace(/\s+/g, " ").trim();
}

// Rank roles must match the complete roster rank name. No aliases or partial matching.
function findSimilarRole(guild, targetName) {
  const target = normalizeRoleName(targetName);
  return guild.roles.cache.find(r => !r.managed && normalizeRoleName(r.name) === target) || null;
}

async function getExistingRoleById(guild, roleId) {
  if (!roleId) return null;
  const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
  return role && !role.managed ? role : null;
}

async function applyAutoOnboardRoles(guild, member) {
  const applied = [];
  const missing = [];

  for (const roleId of AUTO_ONBOARD_ROLE_IDS) {
    const role = await getExistingRoleById(guild, roleId);
    if (!role) {
      missing.push(roleId);
      continue;
    }
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role);
      applied.push(role.name);
    }
  }

  return { applied, missing };
}

async function removeAutoOnboardRoles(guild, member) {
  for (const roleId of AUTO_ONBOARD_ROLE_IDS) {
    const role = await getExistingRoleById(guild, roleId);
    if (role && member.roles.cache.has(role.id)) {
      await member.roles.remove(role).catch(err => console.error(`Failed to remove onboarding role ${role.id}:`, err));
    }
  }
}

function findRoleByMentionable(guild, roleId) { return roleId ? guild.roles.cache.get(roleId) || null : null; }

// Permission / supervisory roles are extra existing roles. Rank roles themselves are exact-name matched.
async function applySupportRankRole(guild, member, rank) {
  const ranks = await liveRanks();
  const rankIndex = ranks.findIndex(r => normalizeRoleName(r) === normalizeRoleName(rank));
  const commanderIndex = ranks.findIndex(r => normalizeRoleName(r) === "agent commander");

  const highRole = await getExistingRoleById(guild, DHS_ROLE_IDS.highCommand);
  if (highRole && commanderIndex !== -1 && rankIndex !== -1) {
    const shouldHave = rankIndex <= commanderIndex;
    if (shouldHave && !member.roles.cache.has(highRole.id)) await member.roles.add(highRole);
    if (!shouldHave && member.roles.cache.has(highRole.id)) await member.roles.remove(highRole).catch(() => {});
  }

  const chiefPre = await getExistingRoleById(guild, DHS_ROLE_IDS.chiefOfStaffPreCommand);
  if (chiefPre) {
    const shouldHave = normalizeRoleName(rank) === "chief of staff";
    if (shouldHave && !member.roles.cache.has(chiefPre.id)) await member.roles.add(chiefPre);
    if (!shouldHave && member.roles.cache.has(chiefPre.id)) await member.roles.remove(chiefPre).catch(() => {});
  }
}

const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
if (!C.spreadsheetId) throw new Error("GOOGLE_SHEET_ID is required.");
if (!creds.client_email || !creds.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is required.");
creds.private_key = String(creds.private_key).replace(/\\n/g, "\n");
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth });

async function getValues(sheet, range = "") {
  const ref = range ? `${sheet}!${range}` : sheet;
  const res = await withTimeout(sheets.spreadsheets.values.get({ spreadsheetId: C.spreadsheetId, range: ref }), 15000, `Google Sheets read (${ref})`);
  return res.data.values || [];
}
async function setCell(sheet, ref, value) {
  await withTimeout(sheets.spreadsheets.values.update({
    spreadsheetId: C.spreadsheetId,
    range: `${sheet}!${ref}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] }
  }), 15000, `Google Sheets write (${sheet}!${ref})`);
}
async function setCells(sheet, updates) {
  const data = Object.entries(updates).map(([ref, value]) => ({ range: `${sheet}!${ref}`, values: [[value]] }));
  if (!data.length) return;
  await withTimeout(sheets.spreadsheets.values.batchUpdate({ spreadsheetId: C.spreadsheetId, requestBody: { valueInputOption: "USER_ENTERED", data } }), 15000, `Google Sheets batch write (${sheet})`);
}

async function rosterRows() { return getValues(C.rosterSheet); }
async function dbRows() { return getValues(C.databaseSheet); }
async function findDatabaseByDiscordId(id) {
  const rows = await dbRows();
  for (let i = 1; i < rows.length; i++) if (clean(cell(rows[i], C.dbDiscordIdCol)) === String(id)) return { row: i + 1, values: rows[i], rpName: clean(cell(rows[i], C.dbRpNameCol)) };
  return null;
}
async function findDatabaseByBadge(badge) {
  const rows = await dbRows();
  for (let i = 1; i < rows.length; i++) if (clean(cell(rows[i], C.dbBadgeCol)) === clean(badge)) return { row: i + 1, values: rows[i] };
  return null;
}
async function findRosterByBadge(badge) {
  const rows = await rosterRows();
  for (let i = 1; i < rows.length; i++) if (clean(cell(rows[i], C.rosterBadgeCol)) === clean(badge)) return { row: i + 1, rank: clean(cell(rows[i], C.rosterRankCol)), callsign: clean(cell(rows[i], C.rosterCallsignCol)), values: rows[i] };
  return null;
}
async function findRosterByDiscordId(id) {
  const db = await findDatabaseByDiscordId(id);
  if (!db) return null;
  const badge = clean(cell(db.values, C.dbBadgeCol));
  const roster = await findRosterByBadge(badge);
  return { db, roster, badge };
}
function validDhsCallsign(value) {
  const n = Number(clean(value));
  return Number.isInteger(n) && (
    (n >= 201 && n <= 233) ||
    (n >= 301 && n <= 359) ||
    (n >= 401 && n <= 499) ||
    (n >= 501 && n <= 590) ||
    (n >= 601 && n <= 619)
  );
}

async function findOpenRosterSlot(rank) {
  const rows = await rosterRows();
  const wanted = normalizeRoleName(rank);
  for (let i = 1; i < rows.length; i++) {
    const rowRank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    const badge = clean(cell(rows[i], C.rosterBadgeCol));
    if (normalizeRoleName(rowRank) !== wanted) continue;
    if (badge || !validDhsCallsign(callsign)) continue;
    return { row: i + 1, rank: rowRank, callsign };
  }
  return null;
}

async function liveRanks(prefix = "") {
  const rows = await rosterRows();
  const seen = new Map();
  const p = clean(prefix).toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    const rank = clean(cell(rows[i], C.rosterRankCol));
    if (!rank) continue;
    const key = normalizeRoleName(rank);
    if ((!p || key.includes(p)) && !seen.has(key)) seen.set(key, rank);
  }
  return [...seen.values()];
}

function badgeNumber(value) {
  const s = clean(value).replace(/,/g, "");
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : NaN;
}

async function findHighestAvailableBadge() {
  const rows = await dbRows();
  const available = [];
  for (let i = 1; i < rows.length; i++) {
    const badge = clean(cell(rows[i], C.dbBadgeCol));
    const discordId = clean(cell(rows[i], C.dbDiscordIdCol));
    if (!badge || discordId) continue;
    const n = badgeNumber(badge);
    if (!Number.isNaN(n)) available.push({ row: i + 1, values: rows[i], badge, number: n });
  }
  available.sort((a, b) => b.number - a.number);
  return available[0] || null;
}

function actionEmbed(title, color, description, actor, fields = []) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description || "").addFields(fields).setFooter({ text: `${DEPARTMENT} • ${actor}` }).setTimestamp();
}
async function memberRoleTarget(guild, rank) { return findSimilarRole(guild, rank); }
async function applyRankRole(guild, member, newRank, oldRank = "") {
  const newRole = await memberRoleTarget(guild, newRank);
  if (!newRole) {
    throw new Error(`I could not find the existing Discord role for "${newRank}". No role was created.`);
  }

  const ranks = await liveRanks();
  for (const rank of ranks) {
    const role = await memberRoleTarget(guild, rank);
    if (!role || role.managed || role.id === newRole.id) continue;

    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role).catch(err =>
        console.error(`Failed to remove old rank role ${role.name}:`, err)
      );
    }
  }

  if (!member.roles.cache.has(newRole.id)) {
    await member.roles.add(newRole).catch(err =>
      console.error(`Failed to add new rank role ${newRole.name}:`, err)
    );
  }

  await applySupportRankRole(guild, member, newRank);
  return newRole;
}

async function removeRankRole(guild, member, rank) {
  const role = await memberRoleTarget(guild, rank);
  if (role && member.roles.cache.has(role.id)) await member.roles.remove(role).catch(() => {});
}
async function setMemberNickname(member, callsign, rpName = "") {
  if (!member?.manageable || !callsign) return false;

  const cleanRpName = clean(rpName) ||
    clean(member.nickname || member.user?.displayName || "Member")
      .split("|")
      .slice(1)
      .join("|")
      .trim();

  if (!cleanRpName) return false;

  const nickname = `${callsign} | ${cleanRpName}`.slice(0, 32);

  try {
    await member.setNickname(nickname);
    return true;
  } catch (err) {
    console.error("Nickname update failed:", err);
    return false;
  }
}

async function sendDM(member, embed, content = "") { try { await member.send({ content, embeds: [embed] }); return true; } catch { return false; } }
async function configuredChannel(guild, channelId) { if (!channelId) return null; const ch = await guild.channels.fetch(channelId).catch(() => null); return ch?.isTextBased() ? ch : null; }
async function sendAudit(guild, embed) {
  const cfg = guildSettings(guild.id);
  const ch = await configuredChannel(guild, cfg.auditChannelId);
  if (!ch) return;
  try { await withTimeout(ch.send({ embeds: [embed] }), 10000, "audit log send"); }
  catch (err) { console.error("Failed to send audit log:", err); }
}
async function sendTypedLog(guild, type, embed) {
  const cfg = guildSettings(guild.id);
  const ch = await configuredChannel(guild, cfg.logChannels[type] || "");
  if (ch) {
    try { await withTimeout(ch.send({ embeds: [embed] }), 10000, `${type} log send`); }
    catch (err) { console.error(`Failed to send ${type} log:`, err); }
  } else {
    console.warn(`No configured ${type} log channel for guild ${guild.id}`);
  }
  await sendAudit(guild, embed);
}
function canCommandTeam(interaction) {
  const cfg = guildSettings(interaction.guildId);
  return cfg.logRoleId && interaction.member?.roles?.cache?.has(cfg.logRoleId);
}
function canConfigure(interaction) { return C.owners.has(interaction.user.id) || canCommandTeam(interaction); }
const ownerIds = new Set((process.env.OWNER_IDS || "").split(",").map(s => s.trim()).filter(Boolean));
const C_OWN = { owners: ownerIds }; // backwards compatibility for helper naming
function isOwner(interaction) { return C_OWN.owners.has(interaction.user.id); }

const PERMISSION_COMMANDS = [
  ["onboard", "Onboard"],
  ["promotion", "Promotion"],
  ["move", "Move / Rank Change"],
  ["status", "Status"],
  ["lookup", "Lookup"],
  ["strike", "Strike"],
  ["loa", "LOA"],
  ["clear", "Clear Records"],
  ["list", "List Records"],
  ["terminate", "Termination"],
  ["resign", "Resignation"],
  ["reinstate", "Reinstate"],
  ["ranks", "Ranks"],
  ["mass", "Mass Promotions / Demotions"],
  ["removal-logs", "Removal Logs"],
  ["demotion-logs", "Demotion Logs"],
  ["transfer-logs", "Transfer Logs"],
  ["task-logs", "Command Task Logs"],
  ["inactivity-warning-logs", "Inactivity Warning Logs"],
  ["loa-logs", "LOA Logs"],
  ["supervisor-interview-logs", "Supervisor Interview Logs"],
  ["fta-interview-logs", "FTA Interview Logs"],
  ["training", "Training Logs"],
  ["host", "Host Training"],
  ["fto-set", "FTO Setup"]
];

function permissionKeyForInteraction(i) {
  const cmd = i.commandName;
  if (cmd === "training" && i.isChatInputCommand()) return "training";
  if (cmd === "host" && i.isChatInputCommand()) return "host";
  if (cmd === "mass" && i.isChatInputCommand()) return "mass";
  return cmd;
}

async function hasCommandAccess(i, key) {
  if (isOwner(i)) return true;
  const cfg = guildSettings(i.guildId);
  const allowed = new Set((cfg.commandPermissions?.[key] || []).filter(Boolean));
  if (!allowed.size) return false;
  let member = i.member;
  if (!member?.roles?.cache) {
    member = await i.guild.members.fetch(i.user.id).catch(() => null);
  }
  return !!member?.roles?.cache && [...allowed].some(roleId => member.roles.cache.has(roleId));
}

async function requireCommandAccess(i, key) {
  if (await hasCommandAccess(i, key)) return;
  throw new Error(`You do not have a role with access to **/${key}**. Ask a bot owner to configure it with /permissions.`);
}

function permissionListText(guild) {
  const cfg = guildSettings(guild.id);
  return PERMISSION_COMMANDS.map(([key, label]) => {
    const roles = cfg.commandPermissions?.[key] || [];
    return `**${label}** (/${key}): ${roles.length ? roles.map(id => `<@&${id}>`).join(", ") : "Owner only"}`;
  }).join("\n");
}

const commands = [
  new SlashCommandBuilder().setName("onboard").setDescription("Onboard a new DHS agent.")
    .addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true))
    .addStringOption(o => o.setName("rp_name").setDescription("Roleplay name").setRequired(true))
    .addStringOption(o => o.setName("rank").setDescription("Rank from Personnel Roster column B").setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName("move").setDescription("Move a DHS agent to another rank.")
    .addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true))
    .addStringOption(o => o.setName("rank").setDescription("New rank").setAutocomplete(true).setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("status").setDescription("Set DHS status.")
    .addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true))
    .addStringOption(o => o.setName("status").setDescription("Status").setRequired(true).addChoices(...STATUS.map(s => ({name:s,value:s}))))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("lookup").setDescription("Lookup a DHS agent.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)),
  new SlashCommandBuilder().setName("strike").setDescription("Issue the next available strike.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("loa").setDescription("Place a DHS agent on LOA.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("clear").setDescription("Clear a record.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)).addStringOption(o => o.setName("kind").setDescription("Record").setRequired(true).addChoices({name:"Strike 1",value:"strike1"},{name:"Strike 2",value:"strike2"},{name:"All Strikes",value:"strikes"},{name:"LOA",value:"loa"})),
  new SlashCommandBuilder().setName("list").setDescription("List active flags.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)),
  new SlashCommandBuilder().setName("terminate").setDescription("Terminate a DHS agent.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("resign").setDescription("Mark a DHS agent resigned.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("reinstate").setDescription("Reinstate a DHS agent to Active.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)),
  new SlashCommandBuilder().setName("ranks").setDescription("List valid MS ranks from Personnel Roster in command order."),
  new SlashCommandBuilder().setName("mass").setDescription("Bulk rank movements.")
    .addSubcommand(s => s.setName("promotions").setDescription("Bulk promote members from one rank to another.").addStringOption(o=>o.setName("from_rank").setDescription("Current rank").setAutocomplete(true).setRequired(true)).addStringOption(o=>o.setName("to_rank").setDescription("New rank").setAutocomplete(true).setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(false)))
    .addSubcommand(s => s.setName("demotions").setDescription("Bulk demote members from one rank to another.").addStringOption(o=>o.setName("from_rank").setDescription("Current rank").setAutocomplete(true).setRequired(true)).addStringOption(o=>o.setName("to_rank").setDescription("New rank").setAutocomplete(true).setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(false))),
  new SlashCommandBuilder().setName("permissions").setDescription("Manage which roles can use department commands.")
    .addSubcommand(s=>s.setName("add").setDescription("Allow a role to use a command.")
      .addStringOption(o=>o.setName("command").setDescription("Command to allow").setRequired(true).addChoices(...PERMISSION_COMMANDS.map(([name,label])=>({name:label,value:name}))))
      .addRoleOption(o=>o.setName("role").setDescription("Role to grant access").setRequired(true)))
    .addSubcommand(s=>s.setName("remove").setDescription("Remove a role's access to a command.")
      .addStringOption(o=>o.setName("command").setDescription("Command").setRequired(true).addChoices(...PERMISSION_COMMANDS.map(([name,label])=>({name:label,value:name}))))
      .addRoleOption(o=>o.setName("role").setDescription("Role to remove").setRequired(true)))
    .addSubcommand(s=>s.setName("view").setDescription("View command role permissions."))
    .addSubcommand(s=>s.setName("clear").setDescription("Remove all role permissions for one command.")
      .addStringOption(o=>o.setName("command").setDescription("Command").setRequired(true).addChoices(...PERMISSION_COMMANDS.map(([name,label])=>({name:label,value:name}))))),
  new SlashCommandBuilder().setName("command").setDescription("Command-team configuration.")
    .addSubcommandGroup(g => g.setName("role").setDescription("Command-team roles.").addSubcommand(s=>s.setName("log").setDescription("Set the role allowed to create command logs.").addRoleOption(o=>o.setName("role").setDescription("Command team role").setRequired(true))).addSubcommand(s=>s.setName("view").setDescription("View the configured command log role."))),
  new SlashCommandBuilder().setName("logs").setDescription("Logging configuration.")
    .addSubcommand(s=>s.setName("channel").setDescription("Set a log destination.").addStringOption(o=>o.setName("type").setDescription("Log type").setRequired(true).addChoices(...Object.values(LOG_TYPES).map(x=>({name:x.label,value:x.key})),{name:"Audit / General",value:"audit"})).addChannelOption(o=>o.setName("channel").setDescription("Destination channel").setRequired(true)))
    .addSubcommand(s=>s.setName("status").setDescription("Show log configuration.")),
  new SlashCommandBuilder().setName("promotion").setDescription("Promote an individual DHS agent.")
    .addUserOption(o=>o.setName("user").setDescription("Discord member").setRequired(true))
    .addStringOption(o=>o.setName("rank").setDescription("New rank from Personnel Roster").setAutocomplete(true).setRequired(true))
    .addStringOption(o=>o.setName("reason").setDescription("Promotion reason").setRequired(false)),
  new SlashCommandBuilder().setName("promotion-logs").setDescription("Set the channel where promotion logs are posted.")
    .addChannelOption(o=>o.setName("channel").setDescription("Promotion log channel").setRequired(true)),
  new SlashCommandBuilder().setName("removal-logs").setDescription("Create a removal log.").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("demotion-logs").setDescription("Create a demotion log.").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("transfer-logs").setDescription("Create a transfer log.").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("task-logs").setDescription("Create a task log.").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Task / action").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("inactivity-warning-logs").setDescription("Create an inactivity warning log.").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("loa-logs").setDescription("Create a LOA log.").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("supervisor-interview-logs").setDescription("Create a supervisor interview log.").addUserOption(o=>o.setName("user").setDescription("Candidate").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Outcome / topic").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("fta-interview-logs").setDescription("Create an FTA interview log.").addUserOption(o=>o.setName("user").setDescription("Candidate").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Outcome / topic").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("training").setDescription("Training logging.").addSubcommand(s=>s.setName("log").setDescription("Log training results and trainers.").addStringOption(o=>o.setName("passed").setDescription("Cadets passed (mentions or IDs, comma separated)").setRequired(false)).addStringOption(o=>o.setName("failed").setDescription("Cadets failed (mentions or IDs, comma separated)").setRequired(false)).addStringOption(o=>o.setName("ftos").setDescription("FTOs who trained/helped (mentions or IDs, comma separated)").setRequired(false)).addStringOption(o=>o.setName("ftas").setDescription("FTAs who trained/helped (mentions or IDs, comma separated)").setRequired(false)).addStringOption(o=>o.setName("details").setDescription("Additional training notes").setRequired(false))),
  new SlashCommandBuilder().setName("host").setDescription("Training hosting.").addSubcommand(s=>s.setName("training").setDescription("Host a cadet / FTO training.").addStringOption(o=>o.setName("time").setDescription("Start time, e.g. 18:30 or 6:30 PM").setRequired(true))),
  new SlashCommandBuilder().setName("setup").setDescription("Configure DHS server channels and training roles.")
    .addSubcommand(s=>s.setName("training-channels").setDescription("Set training channels.")
      .addChannelOption(o=>o.setName("trainee").setDescription("Trainee announcement channel").setRequired(true))
      .addChannelOption(o=>o.setName("trainers").setDescription("FTO / FTA announcement channel").setRequired(true))
      .addChannelOption(o=>o.setName("info").setDescription("Training information channel").setRequired(true)))
    .addSubcommand(s=>s.setName("training-roles").setDescription("Set training roles.")
      .addRoleOption(o=>o.setName("trainee").setDescription("Trainee / cadet role").setRequired(true))
      .addRoleOption(o=>o.setName("fto").setDescription("FTO role").setRequired(true))
      .addRoleOption(o=>o.setName("fta").setDescription("FTA role").setRequired(false)))
    .addSubcommand(s=>s.setName("view").setDescription("View DHS bot configuration.")),
  new SlashCommandBuilder().setName("fto-set").setDescription("Set the existing role allowed to host training.").addRoleOption(o=>o.setName("role").setDescription("Existing FTO/FTO-equivalent role").setRequired(true))
];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

function buildLogEmbed(type, target, actor, reason, details) {
  const meta = LOG_TYPES[type] || { label: type };
  const styles = {
    removal: { color: COLORS.red, title: "DHS • Removal Log", icon: "🗑️" },
    demotion: { color: COLORS.red, title: "DHS • Demotion Log", icon: "📉" },
    transfer: { color: COLORS.blue, title: "DHS • Transfer Log", icon: "🔄" },
    task: { color: COLORS.purple, title: "DHS • Command Task Log", icon: "📋" },
    inactivity: { color: COLORS.gold, title: "DHS • Inactivity Warning Log", icon: "⚠️" },
    loa: { color: COLORS.gold, title: "DHS • LOA Log", icon: "🟡" },
    supervisorInterview: { color: COLORS.blue, title: "DHS • Supervisor Interview Log", icon: "🎙️" },
    ftaInterview: { color: COLORS.blue, title: "DHS • FTA Interview Log", icon: "🎙️" },
    training: { color: COLORS.green, title: "DHS • Training Log", icon: "🎓" }
  };

  const style = styles[type] || { color: COLORS.black, title: `DHS • ${meta.label} Log`, icon: "📝" };

  return actionEmbed(
    `${style.icon} ${style.title}`,
    style.color,
    `**${target}**`,
    actor,
    [
      { name: "Reason / Outcome", value: safeText(reason), inline: false },
      { name: "Details", value: safeText(details || "No additional details provided."), inline: false },
      { name: "Logged By", value: actor, inline: true },
      { name: "Department", value: DEPARTMENT, inline: true }
    ]
  );
}

async function handleAdd(i) {
  const member = i.options.getMember("user");
  const rpName = clean(i.options.getString("rp_name", true));
  const rank = clean(i.options.getString("rank", true));

  if (!member) throw new Error("That member is not in this server.");

  if (await findDatabaseByDiscordId(member.id)) {
    throw new Error("That Discord user is already assigned in Personnel Database column I.");
  }

  const db = await findHighestAvailableBadge();
  if (!db) {
    throw new Error("No available badge numbers were found in Personnel Database column B.");
  }

  const slot = await findOpenRosterSlot(rank);
  if (!slot) {
    throw new Error(`No open ${rank} slot with a valid DHS callsign exists in Personnel Roster.`);
  }

  const joinDate = today();
  const promotionDate = joinDate;

  await setCells(C.databaseSheet, {
    [`${C.dbRpNameCol}${db.row}`]: rpName,
    [`${C.dbDiscordIdCol}${db.row}`]: member.id,
    [`${C.dbJoinDateCol}${db.row}`]: joinDate,
    [`${C.dbPromotionDateCol}${db.row}`]: promotionDate,
    [`${C.dbStatusCol}${db.row}`]: "Active",
    [`${C.dbTerminationCol}${db.row}`]: false,
    [`${C.dbResignedCol}${db.row}`]: false,
    [`${C.dbLoaCol}${db.row}`]: false,
    [`${C.dbRankLockedCol}${db.row}`]: false
  });

  // Personnel Roster gets only the badge number; existing sheet formulas populate the other fields.
  await setCell(C.rosterSheet, `${C.rosterBadgeCol}${slot.row}`, db.badge);

  await applyRankRole(i.guild, member, rank);
  const { missing } = await applyAutoOnboardRoles(i.guild, member);
  await setMemberNickname(member, slot.callsign, rpName);

  const actor = `<@${i.user.id}>`;
  const now = DateTime.now().setZone(TRAINING_TZ).toFormat("dd/MM/yyyy HH:mm");
  const simpleLog = `${member} --> ${rank} | Onboarded | ${now} | Approved By: ${actor} | Call Sign: ${slot.callsign}`;

  const embed = actionEmbed(
    "DHS • Onboarding",
    COLORS.green,
    simpleLog,
    actor
  );

  const welcomeEmbed = actionEmbed(
    "🎉 Welcome to DHS",
    COLORS.green,
    `You have been onboarded to **Department of Homeland Security**.`,
    actor,
    [
      { name: "Name on Roster", value: rpName || "—", inline: true },
      { name: "Call Sign", value: slot.callsign || "—", inline: true },
      { name: "Badge Number", value: db.badge || "—", inline: true },
      { name: "Rank", value: rank || "—", inline: true }
    ]
  );

  const welcomeText =
    `🎉 **Welcome to DHS**\n` +
    `You are now a member of the Department of Homeland Security.\n\n` +
    `**Call Sign:** ${slot.callsign}\n` +
    `**Badge Number:** ${db.badge}\n\n` +
    `Please read this message in its entirety to get started as a DHS Agent.\n\n` +
    `DHS operates at the highest level of realism and professionalism. For more information, read:\n` +
    `https://discord.com/channels/1556355219020062850/1556355223843381278\n\n` +
    `**Name on Roster:** ${rpName}`;

  const dmSent = await sendDM(member, welcomeEmbed, welcomeText);
  if (!dmSent) console.warn(`Could not DM onboarded member ${member.id}.`);

  if (i.channel?.isTextBased()) {
    await i.channel.send({
      content: `✅ Successfully onboarded ${member}.`
    }).catch(err => console.error("Onboard confirmation failed:", err));
  }

  const cfg = guildSettings(i.guildId);
  const promoCh = await configuredChannel(i.guild, cfg.promotionChannelId);

  if (promoCh) {
    await promoCh.send({ content: simpleLog }).catch(err =>
      console.error("Promotion/onboarding log failed:", err)
    );
  } else {
    console.warn(`Promotion log channel is not configured for guild ${i.guildId}.`);
  }

  if (missing.length) {
    console.warn(`Onboarding roles missing in guild ${i.guildId}: ${missing.join(", ")}`);
  }

  await sendAudit(i.guild, embed);
  await i.editReply({ embeds: [embed] });
}

async function handleMove(i) {
  const member = i.options.getMember("user");
  const newRank = clean(i.options.getString("rank", true));
  const reason = clean(i.options.getString("reason")) || "Promotion";

  if (!member) throw new Error("Member not found in this server.");

  const state = await findRosterByDiscordId(member.id);
  if (!state?.db) throw new Error("That member has no Personnel Database record.");

  if (state.roster && isTrue(cell(state.db.values, C.dbRankLockedCol))) {
    throw new Error("That member is rank locked and cannot be moved.");
  }

  const slot = await findOpenRosterSlot(newRank);
  if (!slot) throw new Error(`No open ${newRank} slot with a valid callsign exists.`);

  const oldRank = state.roster?.rank || "Unknown";
  const rpName = clean(cell(state.db.values, C.dbRpNameCol));

  if (state.roster) {
    await setCell(C.rosterSheet, `${C.rosterBadgeCol}${state.roster.row}`, "");
  }

  await setCell(C.rosterSheet, `${C.rosterBadgeCol}${slot.row}`, state.badge);
  await setCell(C.databaseSheet, `${C.dbPromotionDateCol}${state.db.row}`, today());

  await applyRankRole(i.guild, member, newRank, oldRank);
  await setMemberNickname(member, slot.callsign, rpName);

  const actor = `<@${i.user.id}>`;
  const now = DateTime.now().setZone(TRAINING_TZ).toFormat("dd/MM/yyyy HH:mm");
  const simpleLog = `${member} --> ${newRank} | ${reason} | ${now} | Approved By: ${actor} | Call Sign: ${slot.callsign}`;

  const embed = actionEmbed(
    "DHS • Promotion",
    COLORS.green,
    simpleLog,
    actor
  );

  const dmEmbed = actionEmbed(
    "🎉 Promotion",
    COLORS.green,
    `You have been promoted to **${newRank}**.`,
    actor,
    [
      { name: "Previous Rank", value: oldRank, inline: true },
      { name: "New Rank", value: newRank, inline: true },
      { name: "Call Sign", value: slot.callsign, inline: true },
      { name: "Badge Number", value: state.badge || "—", inline: true },
      { name: "Reason", value: safeText(reason), inline: false }
    ]
  );

  await sendDM(member, dmEmbed);

  const cfg = guildSettings(i.guildId);
  const promoCh = await configuredChannel(i.guild, cfg.promotionChannelId);

  if (promoCh) {
    await promoCh.send({ content: simpleLog }).catch(err =>
      console.error("Promotion log failed:", err)
    );
  } else {
    console.warn(`Promotion log channel is not configured for guild ${i.guildId}.`);
  }

  await sendAudit(i.guild, embed);
  await i.editReply({ embeds: [embed] });
}

async function handleStatus(i) {
  const member = i.options.getMember("user");
  const state = await findRosterByDiscordId(member.id); if (!state?.db) throw new Error("No Personnel Database record.");
  const status = i.options.getString("status", true); const reason = clean(i.options.getString("reason")) || "Status update."; const actor = `<@${i.user.id}>`;
  await setCell(C.databaseSheet, `${C.dbStatusCol}${state.db.row}`, status);
  if (status === "LOA") await setCell(C.databaseSheet, `${C.dbLoaCol}${state.db.row}`, true);
  const embed = actionEmbed("MS Status Updated", COLORS.blue, `${member} is now **${status}**.`, actor, [{name:"Reason",value:reason}]);
  await sendDM(member, embed); await sendAudit(i.guild, embed); await i.editReply({embeds:[embed]});
}

async function handleStrike(i) {
  const member = i.options.getMember("user"); const reason = i.options.getString("reason", true); const state = await findRosterByDiscordId(member.id); if (!state?.db) throw new Error("No Personnel Database record.");
  const s1 = isTrue(cell(state.db.values, C.dbStrike1Col)); const s2 = isTrue(cell(state.db.values, C.dbStrike2Col));
  if (s1 && s2) throw new Error("Strike 1 and Strike 2 are already active.");
  const target = !s1 ? C.dbStrike1Col : C.dbStrike2Col;
  await setCell(C.databaseSheet, `${target}${state.db.row}`, true);
  const actor = `<@${i.user.id}>`; const embed = actionEmbed("Strike Issued", COLORS.red, `${member} has received **${target === C.dbStrike1Col ? "Strike 1" : "Strike 2"}**.`, actor, [{name:"Reason",value:reason}]);
  await sendDM(member, embed); await sendAudit(i.guild, embed); await i.editReply({embeds:[embed]});
}

async function handleLoa(i) {
  const member = i.options.getMember("user"); const reason = i.options.getString("reason", true); const state = await findRosterByDiscordId(member.id); if (!state?.db) throw new Error("No Personnel Database record.");
  await setCells(C.databaseSheet,{[`$ {C.dbLoaCol}${state.db.row}`]:true}).catch(()=>{});
  await setCells(C.databaseSheet,{[`${C.dbLoaCol}${state.db.row}`]:true,[`${C.dbStatusCol}${state.db.row}`]:"LOA"});
  const actor = `<@${i.user.id}>`; const embed = actionEmbed("LOA Granted", COLORS.gold, `${member} has been placed on **LOA**.`, actor, [{name:"Reason",value:reason}]);
  await sendDM(member, embed); await sendTypedLog(i.guild,"loa",embed); await i.editReply({embeds:[embed]});
}

async function handleClear(i) {
  const member = i.options.getMember("user"); const kind = i.options.getString("kind", true); const state = await findRosterByDiscordId(member.id); if (!state?.db) throw new Error("No Personnel Database record."); const u = {};
  if (kind === "strike1" || kind === "strikes") u[`${C.dbStrike1Col}${state.db.row}`] = false;
  if (kind === "strike2" || kind === "strikes") u[`${C.dbStrike2Col}${state.db.row}`] = false;
  if (kind === "loa") { u[`${C.dbLoaCol}${state.db.row}`] = false; u[`${C.dbStatusCol}${state.db.row}`] = "Active"; }
  await setCells(C.databaseSheet,u); const actor = `<@${i.user.id}>`; const embed = actionEmbed("Records Cleared", COLORS.green, `${member}'s **${kind}** record was cleared.`, actor); await sendAudit(i.guild,embed); await i.editReply({embeds:[embed]});
}

async function handleTerminateResign(i, type) {
  const member = i.options.getMember("user");
  const reason = i.options.getString("reason", true);

  if (!member) throw new Error("Member not found in this server.");

  const state = await findRosterByDiscordId(member.id);
  if (!state?.db) throw new Error("No Personnel Database record.");

  const status = type === "terminate" ? "Terminated" : "Resigned";

  const u = type === "terminate"
    ? {
        [`${C.dbTerminationCol}${state.db.row}`]: true,
        [`${C.dbStatusCol}${state.db.row}`]: "Terminated"
      }
    : {
        [`${C.dbResignedCol}${state.db.row}`]: true,
        [`${C.dbStatusCol}${state.db.row}`]: "Resigned"
      };

  if (state.roster) {
    await setCell(C.rosterSheet, `${C.rosterBadgeCol}${state.roster.row}`, "");
  }

  await setCells(C.databaseSheet, u);

  // Remove the current rank role and every supervisory/onboarding role.
  if (state.roster?.rank) {
    await removeRankRole(i.guild, member, state.roster.rank);
  }

  for (const mapping of SUPPORT_RANK_ROLES) {
    const role = findSimilarRole(i.guild, mapping.roleName);
    if (role && !role.managed && member.roles.cache.has(role.id)) {
      await member.roles.remove(role).catch(err =>
        console.error(`Failed to remove support role ${role.name}:`, err)
      );
    }
  }

  await removeAutoOnboardRoles(i.guild, member);

  // Clearing the nickname restores the member's normal Discord display name.
  if (member.manageable) {
    await member.setNickname(null).catch(err =>
      console.error("Failed to reset member nickname:", err)
    );
  }

  const actor = `<@${i.user.id}>`;
  const now = DateTime.now().setZone(TRAINING_TZ).toFormat("dd/MM/yyyy HH:mm");
  const simpleLog = `${member} --> ${status} | ${reason} | ${now} | Approved By: ${actor} | Call Sign: ${state.roster?.callsign || "—"}`;

  const embed = actionEmbed(
    `DHS • ${status}`,
    COLORS.red,
    simpleLog,
    actor
  );

  await sendDM(member, actionEmbed(
    `DHS • ${status}`,
    COLORS.red,
    `Your DHS status has been changed to **${status}**.\n\n**Reason:** ${reason}`,
    actor,
    [
      { name: "Previous Rank", value: state.roster?.rank || "—", inline: true },
      { name: "Call Sign", value: state.roster?.callsign || "—", inline: true },
      { name: "Badge Number", value: state.badge || "—", inline: true }
    ]
  ));

  await sendTypedLog(i.guild, "removal", embed);
  await i.editReply({ embeds: [embed] });
}

async function handleReinstate(i) {
  const member = i.options.getMember("user"); const state = await findRosterByDiscordId(member.id); if (!state?.db) throw new Error("No Personnel Database record.");
  await setCells(C.databaseSheet,{[`${C.dbStatusCol}${state.db.row}`]:"Active",[`${C.dbTerminationCol}${state.db.row}`]:false,[`${C.dbResignedCol}${state.db.row}`]:false,[`${C.dbLoaCol}${state.db.row}`]:false});
  const actor = `<@${i.user.id}>`; const embed = actionEmbed("DHS Agent Reinstated",COLORS.green,`${member} has been returned to **Active**.`,actor); await sendDM(member,embed); await sendAudit(i.guild,embed); await i.editReply({embeds:[embed]});
}

async function handleLookup(i) {
  const member = i.options.getMember("user"); const state = await findRosterByDiscordId(member.id); if (!state?.db) throw new Error("No Personnel Database record."); const v = state.db.values; const actor = `<@${i.user.id}>`;
  const embed = actionEmbed("DHS Agent Lookup",COLORS.black,`${member}`,actor,[
    {name:"Badge",value:clean(cell(v,C.dbBadgeCol))||"—",inline:true},{name:"Call Sign",value:state.roster?.callsign||"—",inline:true},{name:"Rank",value:state.roster?.rank||"—",inline:true},{name:"Status",value:clean(cell(v,C.dbStatusCol))||"—",inline:true},{name:"Join Date",value:clean(cell(v,C.dbJoinDateCol))||"—",inline:true},{name:"Promotion Date",value:clean(cell(v,C.dbPromotionDateCol))||"—",inline:true},{name:"Strike 1",value:isTrue(cell(v,C.dbStrike1Col))?"ACTIVE":"Clear",inline:true},{name:"Strike 2",value:isTrue(cell(v,C.dbStrike2Col))?"ACTIVE":"Clear",inline:true},{name:"Terminated",value:isTrue(cell(v,C.dbTerminationCol))?"YES":"No",inline:true},{name:"Resigned",value:isTrue(cell(v,C.dbResignedCol))?"YES":"No",inline:true},{name:"LOA",value:isTrue(cell(v,C.dbLoaCol))?"YES":"No",inline:true},{name:"Rank Locked",value:isTrue(cell(v,C.dbRankLockedCol))?"YES":"No",inline:true}
  ]); await i.editReply({embeds:[embed]});
}

async function updateMass(i, sub, fromRank, toRank, reason) {
  if (fromRank.toLowerCase() === toRank.toLowerCase()) throw new Error("The old and new ranks must be different.");
  const rows = await dbRows(); const targets=[];
  for (let idx=1; idx<rows.length; idx++) {
    const did=clean(cell(rows[idx],C.dbDiscordIdCol)); if (!did) continue;
    const st=clean(cell(rows[idx],C.dbStatusCol)); if (["Terminated","Resigned"].includes(st)) continue;
    if (isTrue(cell(rows[idx],C.dbRankLockedCol))) continue;
    const roster=await findRosterByDiscordId(did); if (roster?.roster?.rank?.toLowerCase()===fromRank.toLowerCase()) targets.push({did, state:roster});
  }
  if (!targets.length) return {count:0,skipped:0};
  let done=0, skipped=0;
  for (const t of targets) {
    const slot=await findOpenRosterSlot(toRank); if (!slot) { skipped++; continue; }
    if (t.state.roster) await setCell(C.rosterSheet,`${C.rosterBadgeCol}${t.state.roster.row}`,"");
    await setCell(C.rosterSheet,`${C.rosterBadgeCol}${slot.row}`,t.state.badge); await setCell(C.databaseSheet,`${C.dbPromotionDateCol}${t.state.db.row}`,today());
    const m=await i.guild.members.fetch(t.did).catch(()=>null); if(m){await applyRankRole(i.guild,m,toRank,fromRank);await setMemberNickname(m,slot.callsign,t.state.db.rpName || "Member");}
    done++;
  }
  const actor=`<@${i.user.id}>`; const embed=actionEmbed(`Mass ${sub === "promotions" ? "Promotion" : "Demotion"}`,COLORS.purple,`Processed **${done}** member(s).`,actor,[{name:"From",value:fromRank,inline:true},{name:"To",value:toRank,inline:true},{name:"Skipped",value:String(skipped),inline:true},{name:"Reason",value:safeText(reason||"No reason provided.")}]); await sendAudit(i.guild,embed); const cfg=guildSettings(i.guildId); if(sub === "promotions"){const ch=await configuredChannel(i.guild,cfg.promotionChannelId); if(ch) await ch.send({embeds:[embed]}).catch(()=>{});} else {await sendTypedLog(i.guild,"demotion",embed);} return {count:done,skipped};
}

function parseTrainingTime(input) {
  const raw=clean(input).toUpperCase();
  const zone=TRAINING_TZ;
  const now=DateTime.now().setZone(zone);
  let dt;
  if (/^\d{1,2}:\d{2}$/.test(raw)) { const [h,m]=raw.split(":").map(Number); dt=now.set({hour:h,minute:m,second:0,millisecond:0}); }
  else { dt=DateTime.fromFormat(raw,["h:mm a","hh:mm a","H:mm"],{zone}); if(!dt.isValid) return null; dt=dt.set({year:now.year,month:now.month,day:now.day,second:0,millisecond:0}); }
  if (dt <= now) dt=dt.plus({days:1});
  return dt;
}
function trainingButtons(id) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`training_attend_cadet:${id}`).setLabel("✅ Attending Training").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`training_decline_cadet:${id}`).setLabel("❌ Not Attending").setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`training_attend_fta:${id}`).setLabel("✅ Attending as FTA").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`training_attend_fto:${id}`).setLabel("👍 Attend as Full FTO").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`training_decline_fto:${id}`).setLabel("❌ Not Attending").setStyle(ButtonStyle.Danger)
    )
  ];
}
async function trainingRoles(guild) { const t=guildSettings(guild.id).training; return { cadet:await getExistingRoleById(guild,t.cadetRoleId), fto:await getExistingRoleById(guild,t.ftoRoleId), fta:await getExistingRoleById(guild,t.ftaRoleId || DHS_ROLE_IDS.fta) }; }
async function sendTrainingReminders(record) {
  const guild=client.guilds.cache.get(record.guildId); if(!guild) return; const roles=await trainingRoles(guild);
  const tc=guildSettings(guild.id).training; const cadetCh=await configuredChannel(guild,tc.cadetChannelId); const ftoCh=await configuredChannel(guild,tc.ftoChannelId);
  const soon=`⚠️ <t:${Math.floor(record.startMs/1000)}:R> — Training is starting in **10 minutes**! Please be ready.`;
  if(cadetCh) await cadetCh.send({content:`${roles.cadet?roles.cadet.toString():"@Cadet"} ${soon}`}).catch(()=>{});
  if(ftoCh) await ftoCh.send({content:`${roles.fto?roles.fto.toString():"@FTO"} ${roles.fta?roles.fta.toString():"@FTA"} ${soon}`}).catch(()=>{});
  const attendees=[...new Set([...record.cadetAttendees||[],...record.ftaAttendees||[],...record.ftoAttendees||[]])];
  for(const id of attendees){const m=await guild.members.fetch(id).catch(()=>null);if(!m)continue;const em=actionEmbed("Training Starting Soon",COLORS.gold,`Your **${DEPARTMENT}** training starts in 10 minutes.`,`<@${record.hostId}>`,[{name:"Start Time",value:`<t:${Math.floor(record.startMs/1000)}:F>`,inline:false},{name:"Reminder",value:"Please be ready and have everything prepared."}]);await sendDM(m,em);}
}
async function scheduleTraining(record) {
  const id=record.id; const key=`reminder:${id}`; if(timers.has(key)) clearTimeout(timers.get(key)); const delay=Math.max(1000,record.startMs-10*60*1000-Date.now()); timers.set(key,setTimeout(async()=>{try{await sendTrainingReminders(record)}finally{timers.delete(key)}},Math.min(delay,2147483647)));
}
async function createTraining(i) {
  if (i.guildId !== TRAINING_GUILD_ID && !isOwner(i)) throw new Error("This training system is configured for the DHS server.");
  const cfg=guildSettings(i.guildId); if(!cfg.ftoRoleId && !isOwner(i)) throw new Error("No FTO host role has been configured. Use /fto-set first.");
  if(!isOwner(i) && !i.member?.roles?.cache?.has(cfg.ftoRoleId)) throw new Error("You do not have the configured FTO host role.");
  const dt=parseTrainingTime(i.options.getString("time",true)); if(!dt) throw new Error("Use a time like `18:30` or `6:30 PM`.");
  const guild=i.guild; const roles=await trainingRoles(guild);
  if(!roles.cadet || !roles.fto || !roles.fta) throw new Error("Training roles are not fully configured. Use /setup training-roles first.");
  const id=`${Date.now()}-${Math.random().toString(36).slice(2,8)}`; const startMs=dt.toMillis(); const host=`<@${i.user.id}>`;
  const tc=guildSettings(guild.id).training; const cadetCh=await configuredChannel(guild,tc.cadetChannelId); const ftoCh=await configuredChannel(guild,tc.ftoChannelId); if(!cadetCh||!ftoCh) throw new Error("Training channels could not be found.");
  const timeText=`<t:${Math.floor(startMs/1000)}:F> (<t:${Math.floor(startMs/1000)}:R>)`;
  const cadetMsg=`**${roles.cadet}**\n\nI will be hosting a training in ${timeText}\n\nReact with a [✅] if you're attending as a Cadet.\nReact with a [❌] if you're unable to attend this training.\n\nReminder: Please have everything ready in <#${tc.infoChannelId}>\n\nNote: If caught messing around during this training you will be removed from the training.`;
  const ftoMsg=`**${roles.fto} ${roles.fta}**\n\n${host} will be hosting a training in ${timeText}\n\nReact with a [✅] if you're attending as a FTA.\nReact with a [👍] if you can attend as a Full FTO.\nReact with a [❌] if you're unable to attend this training.\n\nNote: Keep in mind that every FTO must attend at least 2 Cadet trainings a month to stay as FTO!`;
  const em1=actionEmbed("Department of Homeland Security • Training",COLORS.black,cadetMsg,host,[{name:"Training Start",value:timeText}]);
  const em2=actionEmbed("Department of Homeland Security • FTO / FTA Training Notice",COLORS.black,ftoMsg,host,[{name:"Training Start",value:timeText}]);
  const m1=await cadetCh.send({content:roles.cadet.toString(),embeds:[em1],components:[trainingButtons(id)[0]]});
  const m2=await ftoCh.send({content:`${roles.fto} ${roles.fta}`,embeds:[em2],components:[trainingButtons(id)[1]]});
  trainings[id]={id,guildId:i.guildId,hostId:i.user.id,startMs,cadetChannelId:tc.cadetChannelId,ftoChannelId:tc.ftoChannelId,cadetMessageId:m1.id,ftoMessageId:m2.id,cadetAttendees:[],ftaAttendees:[],ftoAttendees:[]};
  await saveTrainings(); await scheduleTraining(trainings[id]);
  const embed=actionEmbed("Training Scheduled",COLORS.green,`Training has been scheduled for ${timeText}.`,host,[{name:"Cadet Channel",value:`<#${tc.cadetChannelId}>`,inline:true},{name:"FTO / FTA Channel",value:`<#${tc.ftoChannelId}>`,inline:true},{name:"No Roles Created",value:"Existing DHS roles only."}]);
  await sendAudit(guild,embed); await i.editReply({embeds:[embed]});
}

client.on("guildMemberAdd", async member => {
  try {
    if (member.guild.id !== TRAINING_GUILD_ID) return;

    for (const roleId of JOIN_ROLE_IDS) {
      const role = await getExistingRoleById(member.guild, roleId);
      if (role && !member.roles.cache.has(role.id)) await member.roles.add(role).catch(err => console.error(`Failed to add join role ${roleId}:`, err));
    }

    const embed = actionEmbed(
      "Welcome to WCRP | Department of Homeland Security",
      COLORS.black,
      "**DHS Agent Program**",
      "Department of Homeland Security",
      [
        { name: "Welcome", value: "Hello, welcome to DHS! If you have any questions, head to https://discord.com/channels/1556355219020062850/1556355225999245399", inline: false },
        { name: "Before Going On Duty", value: "Before you're eligible to go on duty, you must complete a training. Ride-alongs are required before going into RTO, so head here to get them:\nhttps://discord.com/channels/1556355219020062850/1556355227009941565\nhttps://discord.com/channels/1556355219020062850/1556355227442217079\nhttps://discord.com/channels/1556355219020062850/1556355227442217080\nhttps://discord.com/channels/1556355219020062850/1556355227781828679\nhttps://discord.com/channels/1556355219020062850/1556355227781828681", inline: false },
        { name: "New Information / Events", value: "To be notified about any new info/events within DHS, head to https://discord.com/channels/1556355219020062850/1556355223843381280 — here you can also find the DHS Vehicle/Uniforms Documents!", inline: false },
        { name: "Final Step", value: "Make sure you check out https://discord.com/channels/1556355219020062850/1556355223843381278", inline: false }
      ]
    );
    await sendDM(member, embed);
  } catch (err) { console.error("Welcome DM / join roles failed:", err); }
});

client.on("interactionCreate",async i=>{
  try {
    if(i.isAutocomplete()){
      const name=i.commandName; const focused=i.options.getFocused(true); const value=focused?.value||"";
      if((name==="onboard"||name==="move"||name==="promotion"||name==="mass") && focused?.name?.includes("rank")){
        const ranks=await liveRanks(value); return i.respond(ranks.slice(0,25).map(r=>({name:r,value:r})));
      }
      return i.respond([]);
    }
    if(i.isButton()){
      const [kind,id]=i.customId.split(":"); if(!kind.startsWith("training_")) return;
      const record=trainings[id]; if(!record) return i.reply({content:"That training is no longer active.",ephemeral:true});
      const bucket=kind.includes("cadet")?"cadetAttendees":kind.includes("fta")?"ftaAttendees":"ftoAttendees";
      const isDecline=kind.includes("decline"); const arr=new Set(record[bucket]||[]); if(isDecline) arr.delete(i.user.id); else arr.add(i.user.id); record[bucket]=[...arr];
      await saveTrainings(); return i.reply({content:isDecline?"❌ You are marked as not attending.":"✅ You are marked as attending.",ephemeral:true});
    }
    if(!i.isChatInputCommand()) return;
    await i.deferReply({ephemeral:true});
    const cmd=i.commandName;
    if(cmd === "host"){ if(i.options.getSubcommand()==="training") return createTraining(i); }
    if(cmd === "setup"){
      if(!isOwner(i)) throw new Error("Only bot owners can change DHS setup.");
      const sub=i.options.getSubcommand(); const cfg=guildSettings(i.guildId); const t=cfg.training;
      if(sub === "training-channels") { t.cadetChannelId=i.options.getChannel("trainee",true).id; t.ftoChannelId=i.options.getChannel("trainers",true).id; t.infoChannelId=i.options.getChannel("info",true).id; await saveSettings(); return i.editReply({content:"✅ Training channels saved."}); }
      if(sub === "training-roles") { t.cadetRoleId=i.options.getRole("trainee",true).id; t.ftoRoleId=i.options.getRole("fto",true).id; t.ftaRoleId=(i.options.getRole("fta")?.id || DHS_ROLE_IDS.fta); await saveSettings(); return i.editReply({content:"✅ Training roles saved."}); }
      if(sub === "view") return i.editReply({content:[`**DHS Setup**`,`Trainee channel: ${t.cadetChannelId?`<#${t.cadetChannelId}>`:"Not set"}`,`Trainer channel: ${t.ftoChannelId?`<#${t.ftoChannelId}>`:"Not set"}`,`Training info: ${t.infoChannelId?`<#${t.infoChannelId}>`:"Not set"}`,`Trainee role: ${t.cadetRoleId?`<@&${t.cadetRoleId}>`:"Not set"}`,`FTO role: ${t.ftoRoleId?`<@&${t.ftoRoleId}>`:"Not set"}`,`FTA role: ${t.ftaRoleId?`<@&${t.ftaRoleId}>`:"Not set"}`].join("\n")});
    }
    if(cmd === "fto-set"){
      await requireCommandAccess(i, "fto-set");
      const role=i.options.getRole("role",true); guildSettings(i.guildId).ftoRoleId=role.id; await saveSettings(); return i.editReply({content:`✅ Training host role set to ${role}.`});
    }
    if(cmd === "permissions") {
      if(!isOwner(i)) throw new Error("Only bot owners can manage command permissions.");
      const sub = i.options.getSubcommand();
      const cfg = guildSettings(i.guildId);
      if(sub === "view") {
        return i.editReply({content: `**${DEPARTMENT} Command Permissions**\n\n${permissionListText(i.guild)}`});
      }
      const key = i.options.getString("command", true);
      if(sub === "clear") {
        cfg.commandPermissions[key] = [];
        await saveSettings();
        return i.editReply({content:`✅ Cleared role access for **/${key}**. It is now owner-only.`});
      }
      const role = i.options.getRole("role", true);
      if(role.managed) throw new Error("Managed/integration roles cannot be assigned as command permissions.");
      const current = new Set(cfg.commandPermissions[key] || []);
      if(sub === "add") {
        current.add(role.id);
        cfg.commandPermissions[key] = [...current];
        await saveSettings();
        return i.editReply({content:`✅ ${role} can now use **/${key}**.`});
      }
      if(sub === "remove") {
        current.delete(role.id);
        cfg.commandPermissions[key] = [...current];
        await saveSettings();
        return i.editReply({content:`✅ ${role} no longer has access to **/${key}**.`});
      }
    }

    if(cmd === "command"){
      if(!isOwner(i)) throw new Error("Only bot owners can change Command Team configuration.");
      const group=i.options.getSubcommandGroup(), sub=i.options.getSubcommand(); const cfg=guildSettings(i.guildId);
      if(group==="role"&&sub==="log"){const role=i.options.getRole("role",true);cfg.logRoleId=role.id;await saveSettings();return i.editReply({content:`✅ Command log role set to ${role}.`});}
      if(group==="role"&&sub==="view"){return i.editReply({content:`Command log role: ${cfg.logRoleId?`<@&${cfg.logRoleId}>`:"Not set"}`});}
    }
    if(cmd === "logs"){
      if(!isOwner(i)) throw new Error("Only bot owners can configure log channels.");
      const sub=i.options.getSubcommand(); const cfg=guildSettings(i.guildId);
      if(sub==="status"){const rows=[`Audit: ${cfg.auditChannelId?`<#${cfg.auditChannelId}>`:"Not set"}`,`Command Team: ${cfg.logRoleId?`<@&${cfg.logRoleId}>`:"Not set"}`,`Promotion: ${cfg.promotionChannelId?`<#${cfg.promotionChannelId}>`:"Not set"}`,...Object.values(LOG_TYPES).map(x=>`${x.label}: ${cfg.logChannels[x.key]?`<#${cfg.logChannels[x.key]}>`:"Not set"}`)];return i.editReply({content:rows.join("\n")});}
      const type=i.options.getString("type",true), ch=i.options.getChannel("channel",true); if(type==="audit") cfg.auditChannelId=ch.id; else cfg.logChannels[type]=ch.id; await saveSettings(); return i.editReply({content:`✅ ${type} logs will now go to ${ch}.`});
    }
    if(cmd === "promotion"){
      await requireCommandAccess(i, "promotion");
      return handleMove(i);
    }

    if(cmd === "promotion-logs"){
      if(!isOwner(i)) throw new Error("Only bot owners can configure promotion logs.");
      const ch=i.options.getChannel("channel",true);
      guildSettings(i.guildId).promotionChannelId=ch.id;
      await saveSettings();
      return i.editReply({content:`✅ Promotions will now be logged to ${ch}.`});
    }

    const logMap={
      "removal-logs":"removal","demotion-logs":"demotion","transfer-logs":"transfer","task-logs":"task","inactivity-warning-logs":"inactivity","loa-logs":"loa","supervisor-interview-logs":"supervisorInterview","fta-interview-logs":"ftaInterview"
    };
    if(logMap[cmd]){
      await requireCommandAccess(i, logMap[cmd]);
      const member=i.options.getMember("user"); const reason=i.options.getString("reason",true), details=i.options.getString("details")||""; if(!member) throw new Error("Member not found."); const actor=`<@${i.user.id}>`; const em=buildLogEmbed(logMap[cmd],member.user?.tag||member.toString(),actor,reason,details); await sendTypedLog(i.guild,logMap[cmd],em); return i.editReply({embeds:[em]});
    }

    if(cmd === "training") {
      await requireCommandAccess(i, "training");
      if(i.options.getSubcommand() !== "log") throw new Error("Unknown training subcommand.");
      const passed = clean(i.options.getString("passed")||"");
      const failed = clean(i.options.getString("failed")||"");
      const ftos = clean(i.options.getString("ftos")||"");
      const ftas = clean(i.options.getString("ftas")||"");
      const details = clean(i.options.getString("details")||"");
      const actor = `<@${i.user.id}>`;
      const em = actionEmbed("Training Log", COLORS.black, "Department of Homeland Security • Training Record", actor, [
        {name:"Cadets Passed", value:safeText(passed||"None"), inline:false},
        {name:"Cadets Failed", value:safeText(failed||"None"), inline:false},
        {name:"FTOs Trained By", value:safeText(ftos||"None"), inline:false},
        {name:"FTAs Trained By", value:safeText(ftas||"None"), inline:false},
        {name:"Additional Notes", value:safeText(details||"None"), inline:false}
      ]);
      await sendTypedLog(i.guild,"training",em);
      return i.editReply({embeds:[em]});
    }

    if(["onboard","move","status","lookup","strike","loa","clear","terminate","resign","reinstate","list","ranks","mass","promotion"].includes(cmd)) {
      await requireCommandAccess(i, cmd);
    }
    if(cmd === "onboard") return handleAdd(i);
    if(cmd === "move") return handleMove(i);
    if(cmd === "promotion") return handleMove(i);
    if(cmd === "status") return handleStatus(i);
    if(cmd === "lookup") return handleLookup(i);
    if(cmd === "strike") return handleStrike(i);
    if(cmd === "loa") return handleLoa(i);
    if(cmd === "clear") return handleClear(i);
    if(cmd === "terminate") return handleTerminateResign(i,"terminate");
    if(cmd === "resign") return handleTerminateResign(i,"resign");
    if(cmd === "reinstate") return handleReinstate(i);
    if(cmd === "list"){
      const m=i.options.getMember("user"); const s=await findRosterByDiscordId(m.id); if(!s?.db) throw new Error("No Personnel Database record."); const v=s.db.values; const em=actionEmbed("DHS Agent Records",COLORS.black,`${m}`,`<@${i.user.id}>`,[{name:"Strike 1",value:isTrue(cell(v,C.dbStrike1Col))?"ACTIVE":"Clear",inline:true},{name:"Strike 2",value:isTrue(cell(v,C.dbStrike2Col))?"ACTIVE":"Clear",inline:true},{name:"LOA",value:isTrue(cell(v,C.dbLoaCol))?"ACTIVE":"Clear",inline:true},{name:"Terminated",value:isTrue(cell(v,C.dbTerminationCol))?"YES":"No",inline:true},{name:"Resigned",value:isTrue(cell(v,C.dbResignedCol))?"YES":"No",inline:true},{name:"Rank Locked",value:isTrue(cell(v,C.dbRankLockedCol))?"YES":"No",inline:true}]);return i.editReply({embeds:[em]});
    }
    if(cmd === "ranks"){const rs=await liveRanks();const em=actionEmbed("DHS Rank List",COLORS.black,rs.map(r=>`• ${r}`).join("\n")||"No ranks found.",`<@${i.user.id}>`);return i.editReply({embeds:[em]});}
    if(cmd === "mass"){
      const sub=i.options.getSubcommand(); const from=i.options.getString("from_rank",true), to=i.options.getString("to_rank",true), reason=i.options.getString("reason")||"Mass rank movement."; const result=await updateMass(i,sub,from,to,reason); const em=actionEmbed(`Mass ${sub === "promotions" ? "Promotion" : "Demotion"}`,COLORS.purple,`Completed **${result.count}** member(s).`, `<@${i.user.id}>`, [{name:"From",value:from,inline:true},{name:"To",value:to,inline:true},{name:"Skipped",value:String(result.skipped),inline:true}]); await i.editReply({embeds:[em]}); return;
    }
    throw new Error("Unknown command.");
  } catch(e){ console.error(e); await i.editReply({content:`❌ ${e?.message||"Unexpected error."}`,embeds:[]}).catch(()=>{}); }
});

async function registerCommands(){
  const rest=new REST({version:"10"}).setToken(process.env.DISCORD_TOKEN);
  const body=commands.map(c=>c.toJSON());
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),{body});
  console.log(`Registered ${body.length} DHS department commands.`);
}

client.once("clientReady",async()=>{
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
  for(const record of Object.values(trainings)) if(record.startMs>Date.now()) await scheduleTraining(record);
});

client.login(process.env.DISCORD_TOKEN);
