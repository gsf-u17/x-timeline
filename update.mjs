import fs from 'node:fs';

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const REPOST_DEFAULT_LABEL = process.env.REPOST_DEFAULT_LABEL || 'リポスト';

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error('エラー: DISCORD_BOT_TOKEN または DISCORD_CHANNEL_ID が未設定です。');
  process.exit(1);
}

const CACHE_FILE = 'cache_fx.json';
const OUTPUT_FILE = 'tweets.json';

function loadJson(path, fallback) {
  try {
    if (fs.existsSync(path)) {
      return JSON.parse(fs.readFileSync(path, 'utf8'));
    }
  } catch (e) {
    console.warn(`${path} の読み込みに失敗したため初期化します:`, e.message);
  }
  return fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractUrlInfo(msg) {
  const regex = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter|vxtwitter|fxtwitter|fixupx|fixvx)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/i;
  const content = msg.content || '';
  let match = content.match(regex);
  if (!match && Array.isArray(msg.embeds)) {
    for (const emb of msg.embeds) {
      const target = [emb.url, emb.description].filter(Boolean).join('\n');
      match = target.match(regex);
      if (match) break;
    }
  }
  if (!match) return null;
  return { user: match[1], id: match[2] };
}

function formatMedia(mediaObj) {
  if (!mediaObj) return [];
  if (Array.isArray(mediaObj.all) && mediaObj.all.length > 0) {
    return mediaObj.all
      .map((m) => ({
        type: m.type || 'photo',
        url: m.url || '',
        thumbnail_url: m.thumbnail_url || m.url || '',
        width: m.width || 0,
        height: m.height || 0,
        altText: m.altText || ''
      }))
      .filter((m) => m.url);
  }
  const items = [];
  if (Array.isArray(mediaObj.photos)) {
    for (const p of mediaObj.photos) {
      if (p.url) {
        items.push({
          type: 'photo',
          url: p.url,
          thumbnail_url: p.url,
          width: p.width || 0,
          height: p.height || 0,
          altText: p.altText || ''
        });
      }
    }
  }
  if (Array.isArray(mediaObj.videos)) {
    for (const v of mediaObj.videos) {
      if (v.url) {
        items.push({
          type: v.type || 'video',
          url: v.url,
          thumbnail_url: v.thumbnail_url || '',
          width: v.width || 0,
          height: v.height || 0,
          altText: ''
        });
      }
    }
  }
  return items;
}

function formatQuote(q) {
  if (!q) return null;
  return {
    id: q.id || '',
    url: q.url || '',
    text: q.text || '',
    author: {
      name: q.author?.name || '',
      screen_name: q.author?.screen_name || '',
      avatar_url: q.author?.avatar_url || ''
    },
    media: formatMedia(q.media)
  };
}

function formatTweet(t, fallbackUser, fallbackId) {
  const screenName = t.author?.screen_name || fallbackUser;
  const id = t.id || fallbackId;
  return {
    id,
    url: `https://x.com/${screenName}/status/${id}`,
    text: t.text || '',
    created_at: t.created_at || '',
    created_timestamp: t.created_timestamp || 0,
    author: {
      name: t.author?.name || screenName,
      screen_name: screenName,
      avatar_url: t.author?.avatar_url || ''
    },
    media: formatMedia(t.media),
    quote: formatQuote(t.quote)
  };
}

async function fetchFxTweet(user, id) {
  const apiUrl = `https://api.fxtwitter.com/${encodeURIComponent(user)}/status/${encodeURIComponent(id)}`;
  const res = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'x-timeline-json-generator/1.0',
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.code !== 200 || !data.tweet) {
    throw new Error(`API code ${data.code || 'unknown'}`);
  }
  return formatTweet(data.tweet, user, id);
}

async function main() {
  const cache = loadJson(CACHE_FILE, {});
  const prevOutput = loadJson(OUTPUT_FILE, null);

  // Discordから最新50件を取得
  const discordUrl = `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?limit=50`;
  const discordRes = await fetch(discordUrl, {
    headers: {
      'Authorization': `Bot ${BOT_TOKEN}`
    }
  });

  if (!discordRes.ok) {
    const errText = await discordRes.text();
    console.error(`Discord API エラー (${discordRes.status}):`, errText);
    process.exit(1);
  }

  const messages = await discordRes.json();
  const seenIds = new Set();
  const tweets = [];
  const nextCache = {};

  for (const msg of messages) {
    const info = extractUrlInfo(msg);
    if (!info) continue;
    if (seenIds.has(info.id)) continue;
    seenIds.add(info.id);

    const content = msg.content || '';
    const isRepost = content.includes('🔁');
    let repostLabel = '';
    if (isRepost) {
      const lines = content.split(/\r?\n/);
      const repostLine = lines.find((l) => l.includes('🔁')) || '';
      const cleaned = repostLine
        .replace(/https?:\/\/\S+/g, '')
        .replace(/🔁/g, '')
        .trim();
      repostLabel = cleaned || REPOST_DEFAULT_LABEL;
    }

    let tweetData = cache[info.id]?.tweet || null;
    if (!tweetData) {
      try {
        console.log(`新規取得: ${info.user}/status/${info.id}`);
        tweetData = await fetchFxTweet(info.user, info.id);
        await sleep(350);
      } catch (err) {
        console.warn(`取得失敗 (${info.id}): ${err.message}`);
        continue;
      }
    }

    nextCache[info.id] = {
      cached_at: cache[info.id]?.cached_at || Date.now(),
      tweet: tweetData
    };

    tweets.push({
      ...tweetData,
      is_repost: isRepost,
      repost_label: repostLabel,
      discord_timestamp: msg.timestamp || ''
    });
  }

  // キャッシュファイルは常に最新状態で保存（肥大化防止のため現在使っているもののみ残す）
  fs.writeFileSync(CACHE_FILE, JSON.stringify(nextCache, null, 2), 'utf8');

  // 初回、またはツイートの中身が変わった時だけ tweets.json を書き換える
  const prevTweetsJson = prevOutput ? JSON.stringify(prevOutput.tweets) : '';
  const nextTweetsJson = JSON.stringify(tweets);

  if (!fs.existsSync(OUTPUT_FILE) || prevTweetsJson !== nextTweetsJson) {
    const output = {
      updated_at: new Date().toISOString(),
      count: tweets.length,
      tweets
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log(`tweets.json を更新しました (${tweets.length}件)`);
  } else {
    console.log('ツイート内容に変更がないため tweets.json はそのまま維持します。');
  }
}

main().catch((err) => {
  console.error('予期せぬエラー:', err);
  process.exit(1);
});
