import { StatusBar } from 'expo-status-bar';
import * as SQLite from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

const DATABASE_NAME = 'ground.db';
const WEB_STORAGE_KEY = 'ground-state-v3';
const DAYS_TO_REMEMBER = 14;

const DEFAULT_SETTINGS = {
  reminderCount: '1',
  storeJournalInDb: '1',
  streakCount: '1',
  lastOpenedDate: '',
};

const OPENERS = [
  'It is okay to',
  'You do not have to',
  'You can choose to',
  'You are allowed to',
  'A calm life can',
  'Real peace comes from',
  'Some days are for',
  'Your future grows when you',
  'You can protect your budget by',
  'You still deserve joy while you',
];

const MIDDLES = [
  'skip the restaurant and cook at home',
  'wear the clothes you already own',
  'rest instead of keeping up with everyone',
  'enjoy a simple plan that costs less',
  'say no to impulse spending',
  'keep your goals louder than your feed',
  'choose enough over more',
  'give yourself time before buying',
  'stay present with what you have',
  'build slowly without shame',
];

const ENDINGS = [
  'and still have a meaningful day.',
  'without losing your peace.',
  'because your worth is not a receipt.',
  'while you build something steadier.',
  'and that still counts as success.',
  'even when others are spending more.',
  'because progress does not need to be loud.',
  'and let your mood stay grounded.',
  'while you keep your eyes on the future.',
  'because your life is allowed to be simple.',
];

const SAYINGS = buildSayings();

function buildSayings() {
  const sayings = [];
  for (const opener of OPENERS) {
    for (const middle of MIDDLES) {
      for (const ending of ENDINGS) {
        sayings.push(`${opener} ${middle} ${ending}`);
      }
    }
  }
  return sayings;
}

function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDay(dayKey) {
  const [year, month, day] = dayKey.split('-').map((value) => Number.parseInt(value, 10));
  return new Date(year, month - 1, day);
}

function yesterdayKey(date = new Date()) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() - 1);
  return todayKey(copy);
}

function startOfDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function intervalHoursForCount(count) {
  return count === 3 ? 8 : count === 2 ? 12 : 24;
}

function intervalMsForCount(count) {
  return intervalHoursForCount(count) * 60 * 60 * 1000;
}

function slotInfo(date, count) {
  const dayKey = todayKey(date);
  const dayStart = startOfDay(date);
  const intervalMs = intervalMsForCount(count);
  const elapsed = date.getTime() - dayStart.getTime();
  const slotIndex = Math.floor(elapsed / intervalMs);
  const slotKey = `${dayKey}-${slotIndex}`;
  const nextRefreshAt = new Date(dayStart.getTime() + (slotIndex + 1) * intervalMs);

  return { dayKey, slotIndex, slotKey, nextRefreshAt };
}

function settingsToObject(rows) {
  return rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

function defaultState() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    entries: [],
    sentenceHistory: [],
  };
}

function readWebState() {
  try {
    const raw = globalThis.localStorage?.getItem(WEB_STORAGE_KEY);
    if (!raw) {
      return defaultState();
    }

    const parsed = JSON.parse(raw);
    return {
      settings: {
        ...DEFAULT_SETTINGS,
        ...(parsed.settings || {}),
      },
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      sentenceHistory: Array.isArray(parsed.sentenceHistory) ? parsed.sentenceHistory : [],
    };
  } catch {
    return defaultState();
  }
}

function writeWebState(nextState) {
  globalThis.localStorage?.setItem(WEB_STORAGE_KEY, JSON.stringify(nextState));
}

function sanitizeSentenceHistory(history) {
  return history
    .filter((entry) => entry && typeof entry.slotKey === 'string' && typeof entry.sentence === 'string')
    .map((entry) => ({
      slotKey: entry.slotKey,
      dayKey: entry.dayKey,
      sentence: entry.sentence,
      createdAt: entry.createdAt,
    }));
}

function recentSentences(history, currentDayKey) {
  return history
    .filter((entry) => {
      const daysAgo = (parseLocalDay(currentDayKey) - parseLocalDay(entry.dayKey)) / 86400000;
      return daysAgo >= 0 && daysAgo <= DAYS_TO_REMEMBER;
    })
    .map((entry) => entry.sentence);
}

function pickSentence(seedKey, currentDayKey, history) {
  const used = new Set(recentSentences(history, currentDayKey));
  let pool = SAYINGS.filter((sentence) => !used.has(sentence));
  if (!pool.length) {
    pool = SAYINGS;
  }

  const index = hashString(seedKey) % pool.length;
  return pool[index];
}

function getCurrentStreak(history, currentDayKey) {
  const daySet = new Set(history);
  let streak = 0;
  let cursor = currentDayKey;

  while (daySet.has(cursor)) {
    streak += 1;
    cursor = yesterdayKey(parseLocalDay(cursor));
  }

  return streak;
}

function formatCountdown(targetTime, nowTime) {
  const diff = Math.max(0, targetTime.getTime() - nowTime);
  const totalMinutes = Math.ceil(diff / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

function formatEntryDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function GroundPressable({ children, onPress, style, contentStyle, disabled = false, label }) {
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        style,
        hovered && styles.hovered,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <View style={contentStyle}>{children}</View>
    </Pressable>
  );
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [db, setDb] = useState(null);
  const [activeTab, setActiveTab] = useState('home');
  const [reminderCount, setReminderCount] = useState(1);
  const [storeJournalInDb, setStoreJournalInDb] = useState(true);
  const [streakCount, setStreakCount] = useState(1);
  const [history, setHistory] = useState([]);
  const [currentSentence, setCurrentSentence] = useState('');
  const [nextRefreshAt, setNextRefreshAt] = useState(new Date());
  const [now, setNow] = useState(Date.now());
  const [journalText, setJournalText] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const [entries, setEntries] = useState([]);
  const [showStreakPopup, setShowStreakPopup] = useState(false);
  const [streakIncremented, setStreakIncremented] = useState(false);

  const intervalHours = intervalHoursForCount(reminderCount);
  const tabConfig = {
    home: { icon: '⌂', label: 'Home' },
    journal: { icon: '✎', label: 'Journal' },
    cadence: { icon: '◔', label: 'Cadence' },
    history: { icon: '☰', label: 'History' },
  };

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      try {
        const currentDate = new Date();
        const currentDayKey = todayKey(currentDate);

        if (Platform.OS === 'web') {
          const state = readWebState();
          const settings = state.settings;
          const reminderValue = toInteger(settings.reminderCount, 1);
          const currentSlot = slotInfo(currentDate, reminderValue);
          const sanitizedHistory = sanitizeSentenceHistory(state.sentenceHistory);
          const loginDays = Array.from(
            new Set([...(settings.lastOpenedDate ? [settings.lastOpenedDate] : []), currentDayKey])
          ).sort();
          const previousStreakValue = toInteger(settings.streakCount, 1);
          const streakValue =
            settings.lastOpenedDate && settings.lastOpenedDate !== currentDayKey
              ? settings.lastOpenedDate === yesterdayKey(currentDate)
                ? previousStreakValue + 1
                : 1
              : previousStreakValue;
          const streakJustIncremented =
            settings.lastOpenedDate &&
            settings.lastOpenedDate !== currentDayKey &&
            settings.lastOpenedDate === yesterdayKey(currentDate);

          const existingEntry = sanitizedHistory.find((entry) => entry.slotKey === currentSlot.slotKey);
          const sentence =
            existingEntry?.sentence ||
            pickSentence(currentSlot.slotKey, currentDayKey, sanitizedHistory);

          const nextSentenceHistory = [
            ...sanitizedHistory.filter((entry) => entry.slotKey !== currentSlot.slotKey),
            {
              slotKey: currentSlot.slotKey,
              dayKey: currentDayKey,
              sentence,
              createdAt: currentDate.toISOString(),
            },
          ].sort((left, right) => left.slotKey.localeCompare(right.slotKey));

          const nextState = {
            settings: {
              ...settings,
              reminderCount: String(reminderValue),
              streakCount: String(streakValue),
              lastOpenedDate: currentDayKey,
            },
            entries: state.entries,
            sentenceHistory: nextSentenceHistory,
          };

          writeWebState(nextState);

          if (!cancelled) {
            setReminderCount(reminderValue);
            setStoreJournalInDb(settings.storeJournalInDb !== '0');
            setStreakCount(streakValue);
            setHistory(loginDays);
            setCurrentSentence(sentence);
            setNextRefreshAt(currentSlot.nextRefreshAt);
            setEntries(state.entries.slice(0, 20));
            if (streakJustIncremented) {
              setShowStreakPopup(true);
              setStreakIncremented(true);
            }
          }

          return;
        }

        const database = await SQLite.openDatabaseAsync(DATABASE_NAME);

        await database.execAsync(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS journal_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS login_days (
            day_key TEXT PRIMARY KEY NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sentence_history (
            slot_key TEXT PRIMARY KEY NOT NULL,
            day_key TEXT NOT NULL,
            sentence TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
        `);

        for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
          await database.runAsync(
            'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
            key,
            value
          );
        }

        const settingRows = await database.getAllAsync('SELECT key, value FROM settings');
        const settings = settingsToObject(settingRows);
        const reminderValue = toInteger(settings.reminderCount, 1);

        const loginRows = await database.getAllAsync(
          'SELECT day_key AS dayKey FROM login_days ORDER BY day_key ASC'
        );
        const loginDays = loginRows.map((row) => row.dayKey);

        await database.runAsync(
          'INSERT OR IGNORE INTO login_days (day_key) VALUES (?)',
          currentDayKey
        );

        const streakValue =
          settings.lastOpenedDate && settings.lastOpenedDate !== currentDayKey
            ? settings.lastOpenedDate === yesterdayKey(currentDate)
              ? toInteger(settings.streakCount, 1) + 1
              : 1
            : toInteger(settings.streakCount, 1);

        const streakJustIncremented =
          settings.lastOpenedDate &&
          settings.lastOpenedDate !== currentDayKey &&
          settings.lastOpenedDate === yesterdayKey(currentDate);

        await database.runAsync(
          'UPDATE settings SET value = ? WHERE key = ?',
          currentDayKey,
          'lastOpenedDate'
        );
        await database.runAsync(
          'UPDATE settings SET value = ? WHERE key = ?',
          String(streakValue),
          'streakCount'
        );

        const historyRows = await database.getAllAsync(
          'SELECT slot_key AS slotKey, day_key AS dayKey, sentence, created_at AS createdAt FROM sentence_history ORDER BY created_at DESC LIMIT ?',
          DAYS_TO_REMEMBER * 4
        );
        const sanitizedHistory = sanitizeSentenceHistory(historyRows);
        const currentSlot = slotInfo(currentDate, reminderValue);
        const existingEntry = sanitizedHistory.find((entry) => entry.slotKey === currentSlot.slotKey);
        const sentence =
          existingEntry?.sentence ||
          pickSentence(currentSlot.slotKey, currentDayKey, sanitizedHistory);

        await database.runAsync(
          'INSERT OR REPLACE INTO sentence_history (slot_key, day_key, sentence, created_at) VALUES (?, ?, ?, ?)',
          currentSlot.slotKey,
          currentDayKey,
          sentence,
          currentDate.toISOString()
        );

        const journalRows = await database.getAllAsync(
          'SELECT id, content, created_at AS createdAt FROM journal_entries ORDER BY datetime(created_at) DESC LIMIT 20'
        );

        if (!cancelled) {
          setDb(database);
          setReminderCount(reminderValue);
          setStoreJournalInDb(settings.storeJournalInDb !== '0');
          setStreakCount(streakValue);
          setHistory([...loginDays, currentDayKey].filter(Boolean));
          setCurrentSentence(sentence);
          setNextRefreshAt(currentSlot.nextRefreshAt);
          setEntries(journalRows);
          if (streakJustIncremented) {
            setShowStreakPopup(true);
            setStreakIncremented(true);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to start Ground.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    initialize();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (loading || error) {
      return undefined;
    }

    const timeout = Math.max(1000, nextRefreshAt.getTime() - Date.now() + 250);
    const id = setTimeout(() => {
      refreshSentence(reminderCount);
    }, timeout);

    return () => clearTimeout(id);
  }, [loading, error, nextRefreshAt, reminderCount, history]);

  const countdown = useMemo(
    () => formatCountdown(nextRefreshAt, now),
    [nextRefreshAt, now]
  );

  async function persistWebState(nextState) {
    writeWebState(nextState);
  }

  async function updateSetting(key, value) {
    if (Platform.OS === 'web') {
      const state = readWebState();
      const nextSettings = {
        ...state.settings,
        [key]: value,
      };
      await persistWebState({
        ...state,
        settings: nextSettings,
      });
      return nextSettings;
    }

    if (!db) {
      return null;
    }

    await db.runAsync('UPDATE settings SET value = ? WHERE key = ?', value, key);
    return null;
  }

  async function refreshSentence(nextCount = reminderCount) {
    const currentDate = new Date();
    const currentDayKey = todayKey(currentDate);
    const currentSlot = slotInfo(currentDate, nextCount);

    if (Platform.OS === 'web') {
      const state = readWebState();
      const sanitizedHistory = sanitizeSentenceHistory(state.sentenceHistory);
      const existingEntry = sanitizedHistory.find((entry) => entry.slotKey === currentSlot.slotKey);
      const sentence =
        existingEntry?.sentence ||
        pickSentence(currentSlot.slotKey, currentDayKey, sanitizedHistory);
      const nextSentenceHistory = [
        ...sanitizedHistory.filter((entry) => entry.slotKey !== currentSlot.slotKey),
        {
          slotKey: currentSlot.slotKey,
          dayKey: currentDayKey,
          sentence,
          createdAt: currentDate.toISOString(),
        },
      ].sort((left, right) => left.slotKey.localeCompare(right.slotKey));

      await persistWebState({
        ...state,
        sentenceHistory: nextSentenceHistory,
      });
      setCurrentSentence(sentence);
      setNextRefreshAt(currentSlot.nextRefreshAt);
      return;
    }

    if (!db) {
      return;
    }

    const historyRows = await db.getAllAsync(
      'SELECT slot_key AS slotKey, day_key AS dayKey, sentence, created_at AS createdAt FROM sentence_history ORDER BY created_at DESC LIMIT ?',
      DAYS_TO_REMEMBER * 4
    );
    const sanitizedHistory = sanitizeSentenceHistory(historyRows);
    const existingEntry = sanitizedHistory.find((entry) => entry.slotKey === currentSlot.slotKey);
    const sentence =
      existingEntry?.sentence ||
      pickSentence(currentSlot.slotKey, currentDayKey, sanitizedHistory);

    await db.runAsync(
      'INSERT OR REPLACE INTO sentence_history (slot_key, day_key, sentence, created_at) VALUES (?, ?, ?, ?)',
      currentSlot.slotKey,
      currentDayKey,
      sentence,
      currentDate.toISOString()
    );

    setCurrentSentence(sentence);
    setNextRefreshAt(currentSlot.nextRefreshAt);
  }

  async function changeReminderCount(nextCount) {
    setReminderCount(nextCount);
    await updateSetting('reminderCount', String(nextCount));
    await refreshSentence(nextCount);
  }

  async function toggleStoreJournal(nextValue) {
    setStoreJournalInDb(nextValue);
    await updateSetting('storeJournalInDb', nextValue ? '1' : '0');
    setSavedMessage(
      nextValue
        ? 'Journal entries will save locally on this device.'
        : 'Journal entries will stay in the current session.'
    );
  }

  async function saveJournalEntry() {
    const content = journalText.trim();
    if (!content) {
      setSavedMessage('Write something first.');
      return;
    }

    const createdAt = new Date().toISOString();

    if (Platform.OS === 'web') {
      const state = readWebState();
      const nextEntries = storeJournalInDb
        ? [{ id: Date.now(), content, createdAt }, ...state.entries].slice(0, 20)
        : state.entries;

      await persistWebState({
        ...state,
        entries: nextEntries,
      });
      setEntries(nextEntries);
      setSavedMessage(
        storeJournalInDb ? 'Saved locally in your browser.' : 'Kept only in this session.'
      );
      setJournalText('');
      return;
    }

    if (storeJournalInDb && db) {
      await db.runAsync(
        'INSERT INTO journal_entries (content, created_at) VALUES (?, ?)',
        content,
        createdAt
      );
      const journalRows = await db.getAllAsync(
        'SELECT id, content, created_at AS createdAt FROM journal_entries ORDER BY datetime(created_at) DESC LIMIT 20'
      );
      setEntries(journalRows);
      setSavedMessage('Saved to Ground.');
    } else {
      setSavedMessage('Kept only in this session.');
    }

    setJournalText('');
  }

  const streakLabel = `${streakCount} day${streakCount === 1 ? '' : 's'} 🔥`;

  if (loading) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator size="large" color={stylesVars.accent} />
        <Text style={styles.loadingText}>Warming up Ground...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.screen, styles.centered, styles.errorScreen]}>
        <Text style={styles.errorTitle}>Ground could not start.</Text>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <View pointerEvents="none" style={styles.backdrop}>
        <View style={styles.blobTopLeft} />
        <View style={styles.blobTopRight} />
        <View style={styles.blobBottom} />
      </View>

      <View style={styles.cornerNav} pointerEvents="box-none">
        <View style={styles.cornerTopRow}>
          <GroundPressable
            label="Open home"
            onPress={() => setActiveTab('home')}
            style={[styles.cornerButton, activeTab === 'home' && styles.cornerButtonActive]}
            contentStyle={styles.cornerButtonContent}
          >
            <Text
              style={[
                styles.cornerIcon,
                activeTab === 'home' && styles.cornerIconActive,
              ]}
            >
              {tabConfig.home.icon}
            </Text>
            <Text
              style={[
                styles.cornerText,
                activeTab === 'home' && styles.cornerTextActive,
              ]}
            >
              {tabConfig.home.label}
            </Text>
          </GroundPressable>
          <GroundPressable
            label="Open journal"
            onPress={() => setActiveTab('journal')}
            style={[styles.cornerButton, activeTab === 'journal' && styles.cornerButtonActive]}
            contentStyle={styles.cornerButtonContent}
          >
            <Text
              style={[
                styles.cornerIcon,
                activeTab === 'journal' && styles.cornerIconActive,
              ]}
            >
              {tabConfig.journal.icon}
            </Text>
            <Text
              style={[
                styles.cornerText,
                activeTab === 'journal' && styles.cornerTextActive,
              ]}
            >
              {tabConfig.journal.label}
            </Text>
          </GroundPressable>
        </View>
        <View style={styles.cornerBottomRow}>
          <GroundPressable
            label="Open cadence"
            onPress={() => setActiveTab('cadence')}
            style={[styles.cornerButton, activeTab === 'cadence' && styles.cornerButtonActive]}
            contentStyle={styles.cornerButtonContent}
          >
            <Text
              style={[
                styles.cornerIcon,
                activeTab === 'cadence' && styles.cornerIconActive,
              ]}
            >
              {tabConfig.cadence.icon}
            </Text>
            <Text
              style={[
                styles.cornerText,
                activeTab === 'cadence' && styles.cornerTextActive,
              ]}
            >
              {tabConfig.cadence.label}
            </Text>
          </GroundPressable>
          <GroundPressable
            label="Open history"
            onPress={() => setActiveTab('history')}
            style={[styles.cornerButton, activeTab === 'history' && styles.cornerButtonActive]}
            contentStyle={styles.cornerButtonContent}
          >
            <Text
              style={[
                styles.cornerIcon,
                activeTab === 'history' && styles.cornerIconActive,
              ]}
            >
              {tabConfig.history.icon}
            </Text>
            <Text
              style={[
                styles.cornerText,
                activeTab === 'history' && styles.cornerTextActive,
              ]}
            >
              {tabConfig.history.label}
            </Text>
          </GroundPressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.shell}>
          <View style={styles.shellHeader}>
            <Text style={styles.brand}>GROUND</Text>
            <Text style={styles.brandTag}>Daily grounding for your pace</Text>
          </View>

          {activeTab === 'home' && (
            <View style={styles.homeStack}>
              <View style={styles.hero}>
                <Text style={styles.heroEyebrow}>WELCOME</Text>
                <Text style={styles.heroTitle}>Open Ground, then open your widget.</Text>
                <Text style={styles.heroCopy}>
                  Your calm line changes on the cadence you choose, while the rest stays out of the way.
                </Text>
              </View>

              <View style={styles.widgetCard}>
                <View style={styles.rowBetween}>
                  <Text style={styles.sectionNumber}>01</Text>
                  <Text style={styles.streakBadge}>{streakLabel}</Text>
                </View>
                <Text style={styles.sectionLabel}>Widget preview</Text>
                <Text style={styles.widgetSentence}>{currentSentence}</Text>
                <View style={styles.widgetMetaRow}>
                  <Text style={styles.widgetMeta}>Refreshes every {intervalHours} hours</Text>
                  <Text style={styles.widgetMeta}>Next change in {countdown}</Text>
                </View>
              </View>

              <View style={styles.featureGrid}>
                <View style={styles.featureCard}>
                  <Text style={styles.featureNumber}>02</Text>
                  <Text style={styles.featureTitle}>Soft reminders</Text>
                  <Text style={styles.featureCopy}>
                    One calm sentence, refreshed at the pace you pick.
                  </Text>
                </View>
                <View style={styles.featureCard}>
                  <Text style={styles.featureNumber}>03</Text>
                  <Text style={styles.featureTitle}>Quiet streaks</Text>
                  <Text style={styles.featureCopy}>
                    A gentle fire keeps track of your daily openings.
                  </Text>
                </View>
              </View>
            </View>
          )}

          {activeTab === 'cadence' && (
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeadingRow}>
                <Text style={styles.sectionNumber}>02</Text>
                <View style={styles.sectionHeadingCopy}>
                  <Text style={styles.sectionLabel}>Choose cadence</Text>
                  <Text style={styles.cardCopy}>
                    1 sentence every 24 hours, 2 every 12, 3 every 8.
                  </Text>
                </View>
              </View>

              <View style={styles.cadenceRow}>
                {[1, 2, 3].map((count) => (
                  <GroundPressable
                    key={count}
                    label={`Set ${count} sentence${count === 1 ? '' : 's'} per day`}
                    onPress={() => changeReminderCount(count)}
                    style={[
                      styles.cadencePill,
                      reminderCount === count && styles.cadencePillActive,
                    ]}
                    contentStyle={styles.cadenceContent}
                  >
                    <Text
                      style={[
                        styles.cadenceNumber,
                        reminderCount === count && styles.cadenceNumberActive,
                      ]}
                    >
                      {count}
                    </Text>
                    <Text
                      style={[
                        styles.cadenceLabel,
                        reminderCount === count && styles.cadenceLabelActive,
                      ]}
                    >
                      /day
                    </Text>
                  </GroundPressable>
                ))}
              </View>
            </View>
          )}

          {activeTab === 'journal' && (
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeadingRow}>
                <Text style={styles.sectionNumber}>03</Text>
                <View style={styles.sectionHeadingCopy}>
                  <Text style={styles.sectionLabel}>Journal</Text>
                  <Text style={styles.cardCopy}>Open it, write, and keep it local if you want.</Text>
                </View>
                <View style={styles.switchGroup}>
                  <Text style={styles.switchLabel}>Save locally</Text>
                  <Switch
                    value={storeJournalInDb}
                    onValueChange={toggleStoreJournal}
                    trackColor={{ false: '#D6C5AF', true: '#A18A63' }}
                    thumbColor={storeJournalInDb ? '#F6F0E8' : '#F5EBDD'}
                  />
                </View>
              </View>

              <TextInput
                value={journalText}
                onChangeText={setJournalText}
                placeholder="Write a grounded note..."
                placeholderTextColor="#907D67"
                multiline
                style={styles.input}
                textAlignVertical="top"
              />

              <View style={styles.actionsRow}>
                <GroundPressable
                  label="Save journal entry"
                  onPress={saveJournalEntry}
                  style={styles.primaryButton}
                  contentStyle={styles.primaryButtonContent}
                >
                  <Text style={styles.primaryButtonText}>Save entry</Text>
                </GroundPressable>
              </View>

              {!!savedMessage && <Text style={styles.savedMessage}>{savedMessage}</Text>}
            </View>
          )}

          {activeTab === 'history' && (
            <View style={styles.sectionCard}>
              <View style={styles.sectionHeadingRow}>
                <Text style={styles.sectionNumber}>04</Text>
                <View style={styles.sectionHeadingCopy}>
                  <Text style={styles.sectionLabel}>History</Text>
                  <Text style={styles.cardCopy}>Your latest grounded thoughts stay close by.</Text>
                </View>
              </View>
              {entries.length ? (
                <View style={styles.entriesList}>
                  {entries.map((entry, index) => (
                    <View key={entry.id}>
                      {index > 0 ? <View style={styles.separator} /> : null}
                      <Text style={styles.entryDate}>{formatEntryDate(entry.createdAt)}</Text>
                      <Text style={styles.entryText}>{entry.content}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={styles.emptyState}>No saved notes yet.</Text>
              )}
            </View>
          )}
        </View>
      </ScrollView>

      <Modal
        visible={showStreakPopup}
        transparent
        animationType="fade"
        onRequestClose={() => setShowStreakPopup(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.streakModal}>
            <Text style={styles.streakFireEmoji}>🔥</Text>
            <Text style={styles.streakPopupTitle}>{streakCount} Day Streak!</Text>
            <Text style={styles.streakPopupText}>Keep it going!</Text>
            <GroundPressable
              label="Close streak celebration"
              onPress={() => setShowStreakPopup(false)}
              style={styles.modalButton}
              contentStyle={styles.modalButtonContent}
            >
              <Text style={styles.modalButtonText}>Nice!</Text>
            </GroundPressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const stylesVars = {
  background: '#F4EBDD',
  surface: '#FBF6EE',
  surfaceAlt: '#F0E4D3',
  accent: '#8C744F',
  accentDark: '#6E583A',
  text: '#40352A',
  muted: '#7D6B58',
  border: '#E3D5C2',
  danger: '#A35F4B',
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: stylesVars.background,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  blobTopLeft: {
    position: 'absolute',
    top: -30,
    left: -40,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: 'rgba(255, 216, 224, 0.45)',
  },
  blobTopRight: {
    position: 'absolute',
    top: 70,
    right: -50,
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: 'rgba(217, 233, 255, 0.45)',
  },
  blobBottom: {
    position: 'absolute',
    bottom: -60,
    left: '20%',
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: 'rgba(239, 225, 199, 0.58)',
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  cornerNav: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 5,
  },
  cornerTopRow: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  cornerBottomRow: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  cornerButton: {
    width: 74,
    height: 74,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(227, 213, 194, 0.95)',
    backgroundColor: 'rgba(251, 246, 238, 0.96)',
  },
  cornerButtonActive: {
    backgroundColor: stylesVars.accent,
    borderColor: stylesVars.accent,
  },
  cornerButtonContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  cornerIcon: {
    color: stylesVars.text,
    fontSize: 20,
    fontWeight: '800',
  },
  cornerIconActive: {
    color: '#FFF7EB',
  },
  cornerText: {
    color: stylesVars.text,
    fontSize: 10,
    fontWeight: '700',
  },
  cornerTextActive: {
    color: '#FFF7EB',
  },
  content: {
    width: '100%',
    maxWidth: 540,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 112,
    paddingBottom: 112,
    gap: 16,
  },
  shell: {
    gap: 16,
  },
  shellHeader: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
  },
  homeStack: {
    gap: 14,
  },
  brand: {
    color: stylesVars.accentDark,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 4,
  },
  brandTag: {
    color: stylesVars.muted,
    fontSize: 13,
  },
  hero: {
    backgroundColor: 'rgba(251, 246, 238, 0.95)',
    borderColor: stylesVars.border,
    borderWidth: 1,
    borderRadius: 32,
    padding: 22,
    gap: 16,
  },
  card: {
    backgroundColor: stylesVars.surface,
    borderColor: stylesVars.border,
    borderWidth: 1,
    borderRadius: 24,
    padding: 18,
    gap: 14,
  },
  sectionCard: {
    backgroundColor: 'rgba(251, 246, 238, 0.96)',
    borderColor: stylesVars.border,
    borderWidth: 1,
    borderRadius: 28,
    padding: 18,
    gap: 14,
  },
  widgetCard: {
    backgroundColor: stylesVars.accent,
    borderRadius: 32,
    padding: 22,
    gap: 14,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  kicker: {
    color: stylesVars.accentDark,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 3,
  },
  heroEyebrow: {
    color: stylesVars.accentDark,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 3,
  },
  heroTitle: {
    color: stylesVars.text,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '700',
    textAlign: 'center',
  },
  heroCopy: {
    color: stylesVars.muted,
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  title: {
    color: stylesVars.text,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '700',
  },
  subtitle: {
    color: stylesVars.muted,
    fontSize: 16,
    lineHeight: 24,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: stylesVars.border,
    backgroundColor: '#F8F1E6',
  },
  chipActive: {
    backgroundColor: stylesVars.accent,
    borderColor: stylesVars.accent,
  },
  chipContent: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chipText: {
    color: stylesVars.text,
    fontSize: 14,
    fontWeight: '700',
  },
  chipTextActive: {
    color: '#FFF7EB',
  },
  feelingStrip: {
    backgroundColor: 'rgba(239, 228, 211, 0.85)',
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 14,
    alignItems: 'center',
    gap: 2,
  },
  feelingStripLabel: {
    color: stylesVars.muted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  feelingStripValue: {
    color: stylesVars.text,
    fontSize: 18,
    fontWeight: '700',
  },
  feelingNote: {
    color: stylesVars.muted,
    fontSize: 14,
    lineHeight: 22,
  },
  sectionNumber: {
    color: stylesVars.accentDark,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 2,
  },
  sectionLabel: {
    color: stylesVars.accentDark,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  sectionHeadingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
  },
  sectionHeadingCopy: {
    flex: 1,
    gap: 4,
  },
  featureGrid: {
    gap: 12,
  },
  featureCard: {
    backgroundColor: 'rgba(251, 246, 238, 0.96)',
    borderColor: stylesVars.border,
    borderWidth: 1,
    borderRadius: 24,
    padding: 18,
    gap: 8,
  },
  featureNumber: {
    color: stylesVars.accentDark,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 2,
  },
  featureTitle: {
    color: stylesVars.text,
    fontSize: 18,
    fontWeight: '700',
  },
  featureCopy: {
    color: stylesVars.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  widgetTitle: {
    color: '#F8F1E6',
    fontSize: 18,
    fontWeight: '700',
  },
  widgetCopy: {
    color: '#F4E8D8',
    fontSize: 13,
    marginTop: 4,
  },
  streakBadge: {
    color: '#FFF7EB',
    backgroundColor: stylesVars.accentDark,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    fontWeight: '700',
  },
  widgetSentence: {
    color: '#FFFDF7',
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '700',
  },
  widgetMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  widgetMeta: {
    color: '#F4E8D8',
    fontSize: 12,
    fontWeight: '600',
  },
  cardTitle: {
    color: stylesVars.text,
    fontSize: 20,
    fontWeight: '700',
  },
  cardCopy: {
    color: stylesVars.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  cadenceRow: {
    flexDirection: 'row',
    gap: 10,
  },
  cadencePill: {
    flex: 1,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: stylesVars.border,
    backgroundColor: '#F8F1E6',
  },
  cadencePillActive: {
    backgroundColor: stylesVars.accent,
    borderColor: stylesVars.accent,
  },
  cadenceContent: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
  },
  cadenceNumber: {
    color: stylesVars.text,
    fontSize: 22,
    fontWeight: '800',
  },
  cadenceNumberActive: {
    color: '#FFF7EB',
  },
  cadenceLabel: {
    color: stylesVars.muted,
    fontSize: 12,
    marginTop: 2,
    fontWeight: '700',
  },
  cadenceLabelActive: {
    color: '#F4E8D8',
  },
  switchGroup: {
    alignItems: 'flex-end',
    gap: 8,
  },
  switchLabel: {
    color: stylesVars.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  input: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: stylesVars.border,
    borderRadius: 20,
    backgroundColor: '#FFFDF8',
    padding: 16,
    color: stylesVars.text,
    fontSize: 16,
    lineHeight: 24,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  primaryButton: {
    backgroundColor: stylesVars.accentDark,
    borderRadius: 18,
  },
  primaryButtonContent: {
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: '#FFF7EB',
    fontSize: 14,
    fontWeight: '700',
  },
  savedMessage: {
    color: stylesVars.muted,
    fontSize: 13,
  },
  entriesList: {
    gap: 0,
  },
  separator: {
    height: 14,
  },
  entryDate: {
    color: stylesVars.accentDark,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  entryText: {
    color: stylesVars.text,
    fontSize: 15,
    lineHeight: 22,
  },
  emptyState: {
    color: stylesVars.muted,
    fontSize: 14,
    lineHeight: 22,
  },
  loadingText: {
    marginTop: 12,
    color: stylesVars.muted,
    fontSize: 16,
  },
  errorScreen: {
    gap: 10,
  },
  errorTitle: {
    color: stylesVars.danger,
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  errorText: {
    color: stylesVars.text,
    textAlign: 'center',
    lineHeight: 22,
  },
  hovered: {
    transform: [{ translateY: -1 }, { scale: 1.01 }],
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 10,
    elevation: 2,
  },
  pressed: {
    transform: [{ translateY: 1 }, { scale: 0.98 }],
    opacity: 0.94,
  },
  disabled: {
    opacity: 0.5,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  streakModal: {
    backgroundColor: stylesVars.surface,
    borderRadius: 24,
    padding: 32,
    alignItems: 'center',
    gap: 16,
    maxWidth: 300,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowOffset: { width: 0, height: 10 },
    shadowRadius: 20,
    elevation: 5,
  },
  streakFireEmoji: {
    fontSize: 64,
  },
  streakPopupTitle: {
    color: stylesVars.text,
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
  },
  streakPopupText: {
    color: stylesVars.muted,
    fontSize: 16,
    textAlign: 'center',
  },
  modalButton: {
    backgroundColor: stylesVars.accent,
    borderRadius: 18,
    marginTop: 8,
  },
  modalButtonContent: {
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  modalButtonText: {
    color: '#FFF7EB',
    fontSize: 14,
    fontWeight: '700',
  },
});
