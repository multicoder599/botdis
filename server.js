require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { MongoClient } = require('mongodb');
const { FloodWaitError } = require('telegram/errors');

// ─── CONFIG ───
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const SESSION_STRING = process.env.SESSION_STRING;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/channel_manager';

// ─── DIRS ───
const TMP_DIR = path.join(__dirname, 'tmp');
const PROFILES_DIR = path.join(TMP_DIR, 'profiles');
if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });

// ─── STATE ───
const STATE = {
  IDLE: 'idle',
  AWAITING_NAMES: 'awaiting_names',
  AWAITING_PROFILES: 'awaiting_profiles',
  AWAITING_VIDEOS: 'awaiting_videos',
};

// ─── GLOBALS ───
let client;
let db, settingsCol, channelsCol;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── DB ───
async function initDB() {
  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();
  db = mongo.db('channel_manager');
  settingsCol = db.collection('settings');
  channelsCol = db.collection('channels');
  console.log('MongoDB connected');
}

async function getSettings() {
  let s = await settingsCol.findOne({ _id: 'main' });
  if (!s) {
    s = {
      _id: 'main',
      ownerId: null,
      controlChatId: null,
      controlChatType: null, // 'user' | 'chat' | 'channel'
      state: STATE.IDLE,
      creationQueue: [],
      creationIndex: 0,
      creationInProgress: false,
      profileQueue: [],
      profileIndex: 0,
      profileInProgress: false,
      videoQueue: [],
      videoIndex: 0,
      videoInProgress: false,
      totalChannelsCreated: 0,
      totalVideosPosted: 0,
    };
    await settingsCol.insertOne(s);
  }
  return s;
}

async function updateSettings(patch) {
  await settingsCol.updateOne({ _id: 'main' }, { $set: patch }, { upsert: true });
}

// ─── HELPERS ───
async function sendControl(text) {
  const s = await getSettings();
  if (!s.controlChatId) return;
  try {
    let peer;
    if (s.controlChatType === 'channel') peer = new Api.PeerChannel({ channelId: BigInt(s.controlChatId) });
    else if (s.controlChatType === 'chat') peer = new Api.PeerChat({ chatId: BigInt(s.controlChatId) });
    else peer = new Api.PeerUser({ userId: BigInt(s.controlChatId) });
    await client.sendMessage(peer, { message: text, parseMode: 'markdown' });
  } catch (e) {
    console.error('Send control failed:', e.message);
  }
}

function getPeerFromSettings(settings) {
  if (settings.controlChatType === 'channel') return new Api.InputPeerChannel({ channelId: BigInt(settings.controlChatId), accessHash: BigInt(0) });
  if (settings.controlChatType === 'chat') return new Api.InputPeerChat({ chatId: BigInt(settings.controlChatId) });
  return new Api.InputPeerUser({ userId: BigInt(settings.controlChatId), accessHash: BigInt(0) });
}

// ─── MENU ───
async function showMenu() {
  await sendControl(
    `🤖 *Channel Manager*\n\n` +
    `Reply with the option:\n\n` +
    `1️⃣ *Create* — Create channels (1 every 10 mins)\n` +
    `2️⃣ *Profiles* — Set profile photos 1-by-1\n` +
    `3️⃣ *Videos* — Post videos to channels 1-by-1\n` +
    `4️⃣ *Status* — View stats\n\n` +
    `_Send the number or word (create, profiles, videos, status)._`
  );
}

// ─── CHANNEL CREATION ───
async function processCreationQueue() {
  const s = await getSettings();
  if (s.creationInProgress) return;
  await updateSettings({ creationInProgress: true });

  while (true) {
    const settings = await getSettings();
    if (settings.state !== STATE.IDLE || settings.creationIndex >= settings.creationQueue.length) break;

    const name = settings.creationQueue[settings.creationIndex];
    try {
      const result = await client.invoke(
        new Api.channels.CreateChannel({
          title: name,
          about: 'Managed distribution channel',
          megagroup: false,
          broadcast: true,
        })
      );

      const ch = result.chats[0];
      await channelsCol.insertOne({
        channelId: ch.id.toString(),
        accessHash: ch.accessHash.toString(),
        title: name,
        createdAt: new Date(),
        hasPhoto: false,
        postCount: 0,
        active: true,
      });

      await updateSettings({
        creationIndex: settings.creationIndex + 1,
        totalChannelsCreated: settings.totalChannelsCreated + 1,
      });

      await sendControl(`✅ *${settings.creationIndex + 1}/${settings.creationQueue.length}* Created: *${name}*`);
      console.log(`Created: ${name} (${ch.id})`);

      // 10 minutes between creations
      if (settings.creationIndex + 1 < settings.creationQueue.length) {
        await sleep(10 * 60 * 1000);
      }
    } catch (err) {
      if (err instanceof FloodWaitError) {
        await sendControl(`⏳ Flood wait *${err.seconds}s*. Pausing...`);
        await sleep((err.seconds + 10) * 1000);
        continue;
      }
      console.error(`Failed ${name}:`, err.message);
      await sendControl(`❌ Failed: *${name}*\n_${err.message}_`);
      await sleep(10 * 60 * 1000);
    }
  }

  const final = await getSettings();
  if (final.creationQueue.length > 0 && final.creationIndex >= final.creationQueue.length) {
    await sendControl(
      `🎉 *Creation for the day is over!*\n` +
      `✅ *${final.creationIndex}* channels created successfully.`
    );
    await updateSettings({ creationQueue: [], creationIndex: 0, creationInProgress: false });
  } else {
    await updateSettings({ creationInProgress: false });
  }
}

// ─── PROFILE PHOTOS ───
async function processProfileQueue() {
  const s = await getSettings();
  if (s.profileInProgress) return;
  await updateSettings({ profileInProgress: true });

  const channels = await channelsCol.find({ active: true }).sort({ createdAt: 1 }).toArray();

  while (true) {
    const settings = await getSettings();
    const limit = Math.min(settings.profileQueue.length, channels.length);
    if (settings.state !== STATE.IDLE || settings.profileIndex >= limit) break;

    const photoPath = settings.profileQueue[settings.profileIndex];
    const ch = channels[settings.profileIndex];

    if (!ch || !fs.existsSync(photoPath)) {
      await updateSettings({ profileIndex: settings.profileIndex + 1 });
      continue;
    }

    try {
      const file = await client.uploadFile({ file: photoPath, workers: 1 });
      await client.invoke(
        new Api.channels.EditPhoto({
          channel: new Api.InputChannel({
            channelId: BigInt(ch.channelId),
            accessHash: BigInt(ch.accessHash),
          }),
          photo: new Api.InputChatUploadedPhoto({ file }),
        })
      );

      await channelsCol.updateOne({ _id: ch._id }, { $set: { hasPhoto: true } });
      await updateSettings({ profileIndex: settings.profileIndex + 1 });

      await sendControl(`🖼 *${settings.profileIndex + 1}/${limit}* Profile set for: *${ch.title}*`);
      console.log(`Profile set: ${ch.title}`);

      if (settings.profileIndex + 1 < limit) await sleep(30 * 1000);
    } catch (err) {
      if (err instanceof FloodWaitError) {
        await sendControl(`⏳ Profile flood wait *${err.seconds}s*`);
        await sleep((err.seconds + 5) * 1000);
        continue;
      }
      console.error(`Profile failed ${ch.title}:`, err.message);
      await sendControl(`❌ Profile failed for *${ch.title}*`);
      await updateSettings({ profileIndex: settings.profileIndex + 1 });
      await sleep(30 * 1000);
    }
  }

  const final = await getSettings();
  const limit = Math.min(final.profileQueue.length, channels.length);
  if (final.profileQueue.length > 0 && final.profileIndex >= limit) {
    await sendControl(`✅ *Profile photos set done!*\n${final.profileIndex} channels updated.`);
    // Cleanup temp files
    final.profileQueue.forEach((p) => { try { fs.unlinkSync(p); } catch (e) {} });
    await updateSettings({ profileQueue: [], profileIndex: 0, profileInProgress: false });
  } else {
    await updateSettings({ profileInProgress: false });
  }
}

// ─── VIDEO DISTRIBUTION ───
async function processVideoQueue() {
  const s = await getSettings();
  if (s.videoInProgress) return;
  await updateSettings({ videoInProgress: true });

  const channels = await channelsCol.find({ active: true }).sort({ postCount: 1, createdAt: 1 }).toArray();
  if (channels.length === 0) {
    await updateSettings({ videoInProgress: false });
    return;
  }

  while (true) {
    const settings = await getSettings();
    if (settings.state !== STATE.IDLE || settings.videoIndex >= settings.videoQueue.length) break;

    const video = settings.videoQueue[settings.videoIndex];
    const ch = channels[settings.videoIndex % channels.length];

    try {
      const fromPeer = getPeerFromSettings(settings);
      await client.invoke(
        new Api.messages.ForwardMessages({
          fromPeer,
          id: [parseInt(video.messageId)],
          toPeer: new Api.InputPeerChannel({
            channelId: BigInt(ch.channelId),
            accessHash: BigInt(ch.accessHash),
          }),
          dropAuthor: true,
          randomId: [BigInt(Math.floor(Math.random() * 1e15))],
        })
      );

      await channelsCol.updateOne({ _id: ch._id }, { $inc: { postCount: 1 } });
      await updateSettings({
        videoIndex: settings.videoIndex + 1,
        totalVideosPosted: settings.totalVideosPosted + 1,
      });

      await sendControl(`🎬 *${settings.videoIndex + 1}/${settings.videoQueue.length}* Posted to: *${ch.title}*`);
      console.log(`Video posted to ${ch.title}`);

      if (settings.videoIndex + 1 < settings.videoQueue.length) {
        await sleep(2 * 60 * 1000); // 2 minutes between posts
      }
    } catch (err) {
      if (err instanceof FloodWaitError) {
        await sendControl(`⏳ Video flood wait *${err.seconds}s*`);
        await sleep((err.seconds + 5) * 1000);
        continue;
      }
      console.error(`Video failed ${ch.title}:`, err.message);
      await sendControl(`❌ Video failed for *${ch.title}*`);
      await updateSettings({ videoIndex: settings.videoIndex + 1 });
      await sleep(2 * 60 * 1000);
    }
  }

  const final = await getSettings();
  if (final.videoQueue.length > 0 && final.videoIndex >= final.videoQueue.length) {
    await sendControl(`✅ *Video posting complete!*\n${final.videoIndex} videos distributed.`);
    await updateSettings({ videoQueue: [], videoIndex: 0, videoInProgress: false });
  } else {
    await updateSettings({ videoInProgress: false });
  }
}

// ─── MESSAGE HANDLER ───
async function handleMessage(msg) {
  if (!msg || !msg.peerId) return;

  const peerId = msg.peerId;
  const text = (msg.message || '').trim().toLowerCase();
  let settings = await getSettings();

  // Detect chat type and ID
  let chatIdStr = null;
  let chatType = null;
  if (peerId instanceof Api.PeerUser) {
    chatIdStr = peerId.userId.toString();
    chatType = 'user';
  } else if (peerId instanceof Api.PeerChat) {
    chatIdStr = peerId.chatId.toString();
    chatType = 'chat';
  } else if (peerId instanceof Api.PeerChannel) {
    chatIdStr = peerId.channelId.toString();
    chatType = 'channel';
  }

  // Auto-set owner on first message
  if (!settings.ownerId) {
    let ownerId = null;
    if (msg.fromId instanceof Api.PeerUser) ownerId = msg.fromId.userId.toString();
    else if (peerId instanceof Api.PeerUser) ownerId = peerId.userId.toString();
    if (ownerId) {
      await updateSettings({ ownerId, controlChatId: chatIdStr, controlChatType: chatType });
      settings = await getSettings();
    }
  }

  // Only process control chat
  if (chatIdStr !== settings.controlChatId) return;

  // Only owner
  let isOwner = false;
  if (msg.fromId instanceof Api.PeerUser && msg.fromId.userId.toString() === settings.ownerId) isOwner = true;
  if (peerId instanceof Api.PeerUser && peerId.userId.toString() === settings.ownerId) isOwner = true;
  if (!isOwner) return;

  const currentState = settings.state;

  // ─── STATE: AWAITING NAMES ───
  if (currentState === STATE.AWAITING_NAMES) {
    if (text === '/cancel') {
      await updateSettings({ state: STATE.IDLE, creationQueue: [], creationIndex: 0 });
      await sendControl('❌ Channel creation cancelled.');
      return showMenu();
    }

    const names = msg.message.split('\n').map((n) => n.trim()).filter((n) => n.length > 0);
    if (names.length === 0) {
      return sendControl('❌ No valid names found. Send names separated by new lines, or /cancel.');
    }

    await updateSettings({
      state: STATE.IDLE,
      creationQueue: names,
      creationIndex: 0,
      creationInProgress: false,
    });
    await sendControl(
      `✅ Received *${names.length}* channel names.\n` +
      `⏳ Starting creation now: *1 channel every 10 minutes*...\n` +
      `I'll notify you after each one.`
    );
    processCreationQueue();
    return;
  }

  // ─── STATE: AWAITING PROFILES ───
  if (currentState === STATE.AWAITING_PROFILES) {
    if (text === '/done') {
      const s = await getSettings();
      if (s.profileQueue.length === 0) {
        return sendControl('❌ No photos received yet. Forward photos or /cancel.');
      }
      await updateSettings({ state: STATE.IDLE });
      await sendControl(`🖼 Starting profile setup for *${s.profileQueue.length}* photos...`);
      processProfileQueue();
      return;
    }

    if (text === '/cancel') {
      await updateSettings({ state: STATE.IDLE, profileQueue: [] });
      await sendControl('❌ Profile setup cancelled.');
      return showMenu();
    }

    if (msg.media instanceof Api.MessageMediaPhoto) {
      try {
        const buffer = await client.downloadMedia(msg, { workers: 1 });
        const photoPath = path.join(PROFILES_DIR, `profile_${Date.now()}_${msg.id}.jpg`);
        fs.writeFileSync(photoPath, buffer);
        const s = await getSettings();
        const newQueue = [...s.profileQueue, photoPath];
        await updateSettings({ profileQueue: newQueue });
        await sendControl(`📸 Photo *${newQueue.length}* received. Forward more or send */done* to start.`);
      } catch (e) {
        console.error('Photo download error:', e.message);
        await sendControl('❌ Failed to download photo. Try again.');
      }
      return;
    }

    return sendControl('Forward a *photo* here, or send */done* when finished. */cancel* to abort.');
  }

  // ─── STATE: AWAITING VIDEOS ───
  if (currentState === STATE.AWAITING_VIDEOS) {
    if (text === '/done') {
      const s = await getSettings();
      if (s.videoQueue.length === 0) {
        return sendControl('❌ No videos received yet. Forward videos or /cancel.');
      }
      await updateSettings({ state: STATE.IDLE });
      await sendControl(`🎬 Starting video distribution: *${s.videoQueue.length}* videos...`);
      processVideoQueue();
      return;
    }

    if (text === '/cancel') {
      await updateSettings({ state: STATE.IDLE, videoQueue: [] });
      await sendControl('❌ Video posting cancelled.');
      return showMenu();
    }

    const isVideo =
      msg.media instanceof Api.MessageMediaDocument &&
      msg.media.document &&
      (msg.media.document.mimeType?.startsWith('video/') ||
        msg.media.document.attributes?.some((a) => a instanceof Api.DocumentAttributeVideo));

    if (isVideo) {
      const s = await getSettings();
      const newQueue = [...s.videoQueue, { messageId: msg.id.toString(), caption: msg.message || '' }];
      await updateSettings({ videoQueue: newQueue });
      await sendControl(`🎬 Video *${newQueue.length}* received. Forward more or send */done* to start.`);
      return;
    }

    return sendControl('Forward a *video* here, or send */done* when finished. */cancel* to abort.');
  }

  // ─── IDLE: MENU COMMANDS ───
  if (text === '/start' || text === '1' || text === 'create' || text === 'create channels') {
    await updateSettings({ state: STATE.AWAITING_NAMES, creationQueue: [], creationIndex: 0 });
    await sendControl(
      `📢 *Create Channels*\n\n` +
      `Send me the channel names now.\n` +
      `One name per line. Example:\n\n` +
      `Hot Deals Kenya\n` +
      `Nairobi Offers\n` +
      `Mombasa Flash\n\n` +
      `Send */cancel* to abort.`
    );
    return;
  }

  if (text === '2' || text === 'profiles' || text === 'set profiles' || text === 'profile') {
    const count = await channelsCol.countDocuments({ active: true });
    if (count === 0) return sendControl('❌ No channels found. Create channels first with *Create*.');
    await updateSettings({ state: STATE.AWAITING_PROFILES, profileQueue: [], profileIndex: 0 });
    await sendControl(
      `🖼 *Set Profiles*\n\n` +
      `Forward profile photos to me now.\n` +
      `I'll apply them 1-by-1 to your *${count}* channels.\n\n` +
      `Send */done* when you have sent all photos.\n` +
      `Send */cancel* to abort.`
    );
    return;
  }

  if (text === '3' || text === 'videos' || text === 'post videos' || text === 'video') {
    const count = await channelsCol.countDocuments({ active: true });
    if (count === 0) return sendControl('❌ No channels found. Create channels first with *Create*.');
    await updateSettings({ state: STATE.AWAITING_VIDEOS, videoQueue: [], videoIndex: 0 });
    await sendControl(
      `🎬 *Post Videos*\n\n` +
      `Forward videos to me now.\n` +
      `I'll distribute them 1-by-1 across your *${count}* channels.\n\n` +
      `You can do this up to 3 times a day.\n\n` +
      `Send */done* when you have sent all videos.\n` +
      `Send */cancel* to abort.`
    );
    return;
  }

  if (text === '4' || text === 'status') {
    const channels = await channelsCol.countDocuments({ active: true });
    const s = await getSettings();
    await sendControl(
      `📊 *Status*\n\n` +
      `Active Channels: *${channels}*\n` +
      `Total Created: *${s.totalChannelsCreated}*\n` +
      `Total Videos Posted: *${s.totalVideosPosted}*\n\n` +
      `Current State: *${s.state}*\n` +
      `Creation: *${s.creationQueue.length - s.creationIndex}* pending\n` +
      `Profiles: *${s.profileQueue.length - s.profileIndex}* pending\n` +
      `Videos: *${s.videoQueue.length - s.videoIndex}* pending`
    );
    return;
  }

  if (text === '/reset') {
    await channelsCol.deleteMany({});
    await updateSettings({
      state: STATE.IDLE,
      creationQueue: [], creationIndex: 0, creationInProgress: false,
      profileQueue: [], profileIndex: 0, profileInProgress: false,
      videoQueue: [], videoIndex: 0, videoInProgress: false,
      totalChannelsCreated: 0, totalVideosPosted: 0,
    });
    await sendControl('🗑 All data reset. Send */start* to begin.');
    return;
  }

  // Default
  await showMenu();
}

// ─── MAIN ───
async function main() {
  await initDB();
  const settings = await getSettings();

  const stringSession = new StringSession(SESSION_STRING || settings.sessionString || '');
  client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });

  await client.connect();
  if (!(await client.isUserAuthorized())) {
    console.error('❌ Not authorized. Run: node login.js');
    process.exit(1);
  }
  console.log('✅ Telegram client connected');

  // Resume any interrupted queues on restart
  const s = await getSettings();
  if (s.creationQueue.length > s.creationIndex && !s.creationInProgress) {
    console.log('Resuming channel creation...');
    processCreationQueue();
  }
  if (s.profileQueue.length > s.profileIndex && !s.profileInProgress) {
    console.log('Resuming profile setup...');
    processProfileQueue();
  }
  if (s.videoQueue.length > s.videoIndex && !s.videoInProgress) {
    console.log('Resuming video posting...');
    processVideoQueue();
  }

  client.addEventHandler(async (update) => {
    if (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) {
      await handleMessage(update.message);
    }
  });

  await sendControl('🤖 *Channel Manager* is online!\\nSend */start* to open the menu.');
  console.log('Bot running...');
}

main().catch(console.error);