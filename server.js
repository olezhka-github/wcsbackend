const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const moment = require('moment-timezone');
const { json } = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SECRET_KEY = '+*дC19a90-`♫QIAhяw19)9!№оОJЛQ%l';
const IV_LENGTH = SECRET_KEY.length;

const onlineUsers = new Map();

const db = new sqlite3.Database('./users.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS friends (
      username TEXT,
      friend TEXT,
      FOREIGN KEY(username) REFERENCES users(username),
      FOREIGN KEY(friend) REFERENCES users(username)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      message TEXT,
      type TEXT DEFAULT 'message',
      stickerUrl TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(username) REFERENCES users(username)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS profiles (
      username TEXT PRIMARY KEY,
      about TEXT DEFAULT ''
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS uuid (
    username TEXT PRIMARY KEY,
    uuid TEXT DEFAULT ''
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS bans (
      banned_until INTEGER,
      username TEXT PRIMARY KEY,
      banned_by TEXT,
      duration_days INTEGER,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(username) REFERENCES users(username)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller TEXT,
      recipient TEXT,
      status TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(caller) REFERENCES users(username),
      FOREIGN KEY(recipient) REFERENCES users(username)
  )`);
});

// Допоміжна функція для перевірки UUID
function verifyUuid(ws, username, providedUuid, callback) {
  db.get('SELECT uuid FROM uuid WHERE username = ?', [username], (err, row) => {
    if (err || !row) {
      ws.send(JSON.stringify({ action: 'error', message: 'Помилка перевірки UUID' }));
      return;
    }
    if (row.uuid !== providedUuid) {
      ws.send(JSON.stringify({ action: 'error', message: 'Невірний UUID сесії' }));
      return;
    }
    callback();
  });
}

// Обробка WebSocket-з'єднань
wss.on('connection', (ws) => {
  console.log('Новий клієнт підключився');

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (err) {
      ws.send(JSON.stringify({ message: 'Невірний формат повідомлення' }));
      return;
    }
    console.log('Отримане повідомлення:', data);

    switch (data.action) {
      case 'login':
        handleLogin(ws, data.username, data.password);
        break;
      case 'logout':
        handleLogout(ws, data.username, data.uuid);
        break;
      case 'call':
        handleCall(ws, ws.username, data.uuid, data.recipient);
        break;
      case 'answer_call':
        handleAnswerCall(ws, data.caller, ws.username, data.uuid);
        break;
      case 'decline_call':
        handleDeclineCall(ws, data.caller, ws.username, data.uuid);
        break;
      case 'load_call_history':
        handleLoadCallHistory(ws, ws.username, data.uuid);
        break;
      case 'get_online_users':
        handleGetOnlineUsers(ws, data.uuid);
        break;
      case 'ban_user':
        handleBanUser(ws, data.username, data.duration, data.token, data.reason, data.banned_by, data.uuid);
        break;
      case 'get_active_bans':
        handleGetActiveBans(ws, data.uuid);
        break;
      case 'unban_user':
        handleUnbanUser(ws, data.username, data.uuid);
        break;
      case 'create_account':
        handleCreateAccount(ws, data.username, data.password);
        break;
      case 'send_message':
        handleSendMessage(ws, data.username, data.uuid, data.message, data.type, data.stickerUrl);
        break;
      case 'send_sticker':
        handleSendMessage(ws, data.username, data.uuid, '', 'sticker', data.stickerUrl);
        break;
      case 'addFriend':
        handleAddFriend(ws, data.username, data.friendUsername, data.uuid);
        break;
      case 'loadFriendList':
        handleLoadFriendList(ws, data.username, data.uuid);
        break;
      case 'loadChatHistory':
        handleLoadChatHistory(ws, data.uuid);
        break;
      case 'private_message':
        handlePrivateMessage(ws, data.username, data.uuid, data.message, data.recipient);
        break;
      case 'loadUserList':
        handleLoadUserList(ws, data.uuid);
        break;
      case 'get_profile':
        handleGetProfile(ws, data.username, data.uuid);
        break;
      case 'update_profile':
        handleUpdateProfile(ws, data.username, data.about, data.uuid);
        break;
      case 'signal':
        handleSignal(ws, data);
        break;
      default:
        ws.send(JSON.stringify({ message: 'Невідома команда' }));
        break;
    }
  });

  ws.on('close', () => {
    console.log('Клієнт відключився');
    handleUserDisconnect(ws);
  });

  ws.on('error', (error) => {
    console.error('Помилка WebSocket:', error);
  });
});

function handleSignal(ws, data) {
  // За бажанням, можна також перевіряти UUID тут
  const { recipient, signalData, uuid, sender } = data;
  verifyUuid(ws, sender, uuid, () => {
    const recipientWS = onlineUsers.get(recipient);
    if (recipientWS && recipientWS.readyState === WebSocket.OPEN) {
      recipientWS.send(JSON.stringify({
        action: 'signal',
        sender: ws.username,
        signalData,
      }));
    } else {
      ws.send(JSON.stringify({ action: 'signal', success: false, message: 'Одержувач не онлайн' }));
    }
  });
}

// Форматування дати для виводу
function formatDate(dateString) {
  const months = [
    'січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
    'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'
  ];

  const date = new Date(dateString);
  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();

  return `${day} ${month} ${year} року`;
}

// Логін користувача (використовує існуючий UUID з БД)
function handleLogin(ws, username, password) {
  // Перевірка бану
  db.get(
    `SELECT *, DATE(created_at, '+' || duration_days || ' days') AS ban_until 
     FROM bans WHERE username = ?`,
    [username],
    (err, ban) => {
      if (err) {
        ws.send(JSON.stringify({ action: "login", success: false, message: 'Помилка перевірки статусу' }));
        return;
      }

      if (ban) {
        const now = new Date();
        const banUntil = new Date(ban.ban_until);
        if (now < banUntil) {
          ws.send(
            JSON.stringify({
              action: "login",
              success: false,
              message: `Ваш акаунт заблоковано до ${formatDate(ban.ban_until)}\nПричина: ${ban.reason || 'Порушення правил'}\nМодератор: ${ban.banned_by}`,
            })
          );
          return;
        } else {
          // Видалення бану, якщо термін сплив
          db.run('DELETE FROM bans WHERE username = ?', [username]);
        }
      }

      // Перевірка логіна та пароля
      db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, row) => {
        if (err) {
          ws.send(JSON.stringify({ action: "login", success: false, message: 'Помилка сервера' }));
        } else if (row) {
          ws.username = username;
          onlineUsers.set(username, ws);

          // Отримання існуючого UUID з БД
          db.get('SELECT uuid FROM uuid WHERE username = ?', [username], (err, uuidRow) => {
            if (err || !uuidRow) {
              // Якщо UUID ще немає – генеруємо запасний варіант
              const userUuid = uuidv4();
              ws.uuid = userUuid;
              db.run('INSERT OR REPLACE INTO uuid (username, uuid) VALUES (?, ?)', [username, userUuid]);
              sendLoginResponse(ws, username, userUuid);
            } else {
              ws.uuid = uuidRow.uuid;
              sendLoginResponse(ws, username, uuidRow.uuid);
            }
          });
        } else {
          ws.send(JSON.stringify({ action: "login", success: false, message: 'Невірні дані' }));
        }
      });
    }
  );
}

function sendLoginResponse(ws, username, userUuid) {
  // Якщо користувач є модератором, надсилаємо HTML для керування банами
  if (['hideyoshi.xaotiq', 'moderator.roman'].includes(username)) {
    const banPageHTML = `
      <div class="gcard">
        <h3>🔨 Керування банами</h3>
        <div class="ban-control">
          <input type="text" id="ban-username" placeholder="Користувач">
          <input type="number" id="ban-duration" placeholder="Дні" min="1">
          <textarea id="ban-reason" placeholder="Причина"></textarea>
          <button onclick="banUser()">Забанити</button>
          <button onclick="unbanUser()">Розбанити</button>
        </div>
        <div id="active-bans-list"></div>
      </div>
      <script>
        function banUser() {
          const username = document.getElementById('ban-username').value;
          const duration = document.getElementById('ban-duration').value;
          const reason = document.getElementById('ban-reason').value;
          ws.send(JSON.stringify({
            action: 'ban_user',
            username: username,
            duration: duration,
            reason: reason,
            banned_by: '${username}',
            uuid: ws.uuid
          }));
        }
        
        function unbanUser() {
          const username = document.getElementById('ban-username').value;
          ws.send(JSON.stringify({
            action: 'unban_user',
            username: username,
            uuid: ws.uuid
          }));
        }
        
        ws.send(JSON.stringify({action: 'get_active_bans', uuid: ws.uuid}));
      </script>
    `;
    ws.send(JSON.stringify({ action: 'banPage', html: banPageHTML }));
  }

  ws.send(JSON.stringify({ action: "login", success: true, username, uuid: userUuid }));
}

// Створення акаунта (реєстрація з генерацією UUID)
function handleCreateAccount(ws, username, password) {
  db.get('SELECT username FROM users WHERE username = ?', [username], (err, row) => {
    if (err) {
      ws.send(JSON.stringify({ action: 'createAccount', success: false, message: 'Помилка перевірки наявності користувача' }));
      return;
    }
    if (row) {
      ws.send(JSON.stringify({ action: 'createAccount', success: false, message: 'Ім\'я користувача вже існує' }));
    } else {
      db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, password], function (err) {
        if (err) {
          ws.send(JSON.stringify({ action: 'createAccount', success: false, message: 'Помилка під час створення акаунту' }));
        } else {
          // Створення порожнього профілю для нового користувача
          db.run('INSERT INTO profiles (username, about) VALUES (?, ?)', [username, ''], (err) => {
            if (err) {
              console.error('Помилка створення профілю:', err);
            }
          });
          // Генерація UUID під час реєстрації
          const userUuid = uuidv4();
          ws.username = username;
          ws.uuid = userUuid;
          onlineUsers.set(username, ws);
          db.run('INSERT INTO uuid (username, uuid) VALUES (?, ?)', [username, userUuid]);
          ws.send(JSON.stringify({ action: 'createAccount', success: true, username, uuid: userUuid }));
        }
      });
    }
  });
}

// Відправлення повідомлення у загальний чат (перевірка UUID)
function handleSendMessage(ws, username, providedUuid, message, type = 'message', stickerUrl = '') {
  verifyUuid(ws, username, providedUuid, () => {
    const query = `
      INSERT INTO chat_history (username, message, type, stickerUrl)
      VALUES (?, ?, ?, ?)
    `;
    const params = [username, message, type, stickerUrl];

    db.run(query, params, (err) => {
      if (err) {
        ws.send(JSON.stringify({ action: 'sendMessage', success: false, message: 'Помилка під час відправлення повідомлення' }));
      } else {
        // Розсилка повідомлення всім клієнтам
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              action: 'new_message',
              username,
              message: type === 'sticker' ? '' : message,
              type,
              stickerUrl,
            }));
          }
        });
        ws.send(JSON.stringify({ action: 'sendMessage', success: true }));
      }
    });
  });
}

// Приватне повідомлення (перевірка UUID)
function handlePrivateMessage(ws, username, providedUuid, message, recipient) {
  verifyUuid(ws, username, providedUuid, () => {
    const formattedMessage = `[Private] ${username}: ${message}`;
    wss.clients.forEach((client) => {
      if (
        client.readyState === WebSocket.OPEN &&
        (client.username === recipient || client.username === username)
      ) {
        client.send(JSON.stringify({
          action: 'private_message',
          from: username,
          recipient: recipient,
          message: formattedMessage,
        }));
      }
    });
  });
}

// Додавання друга (перевірка UUID)
function handleAddFriend(ws, username, friendUsername, providedUuid) {
  verifyUuid(ws, username, providedUuid, () => {
    db.get('SELECT * FROM users WHERE username = ?', [friendUsername], (err, row) => {
      if (err) {
        ws.send(JSON.stringify({ action: 'addFriend', success: false, message: 'Помилка під час додавання друга' }));
      } else if (row) {
        db.run('INSERT INTO friends (username, friend) VALUES (?, ?)', [username, friendUsername], (err) => {
          if (err) {
            ws.send(JSON.stringify({ action: 'addFriend', success: false, message: 'Помилка під час додавання друга' }));
          } else {
            ws.send(JSON.stringify({ action: 'addFriend', success: true, friendUsername }));
          }
        });
      } else {
        ws.send(JSON.stringify({ action: 'addFriend', success: false, message: 'Користувача не знайдено' }));
      }
    });
  });
}

// Завантаження списку друзів (перевірка UUID)
function handleLoadFriendList(ws, username, providedUuid) {
  verifyUuid(ws, username, providedUuid, () => {
    db.all('SELECT friend FROM friends WHERE username = ?', [username], (err, rows) => {
      if (err) {
        ws.send(JSON.stringify({ action: 'loadFriendList', success: false, message: 'Помилка завантаження списку друзів' }));
      } else {
        const friends = rows.map((row) => row.friend);
        ws.send(JSON.stringify({ action: 'loadFriendList', friends }));
      }
    });
  });
}

// Завантаження історії загального чату (перевірка UUID)
function handleLoadChatHistory(ws, providedUuid) {
  if (!ws.username) {
    ws.send(JSON.stringify({ action: 'loadChatHistory', success: false, message: 'Користувач не авторизований' }));
    return;
  }
  verifyUuid(ws, ws.username, providedUuid, () => {
    db.all('SELECT username, message, type, stickerUrl FROM chat_history ORDER BY id ASC', [], (err, rows) => {
      if (err) {
        ws.send(JSON.stringify({ action: 'loadChatHistory', success: false, message: 'Помилка завантаження історії чату' }));
      } else {
        ws.send(JSON.stringify({ action: 'loadChatHistory', chatHistory: rows }));
      }
    });
  });
}

// Завантаження списку користувачів (перевірка UUID)
function handleLoadUserList(ws, providedUuid) {
  if (!ws.username) {
    ws.send(JSON.stringify({ action: 'loadUserList', success: false, message: 'Користувач не авторизований' }));
    return;
  }
  verifyUuid(ws, ws.username, providedUuid, () => {
    db.all('SELECT username FROM users', [], (err, rows) => {
      if (err) {
        ws.send(JSON.stringify({ action: 'loadUserList', success: false, message: 'Помилка завантаження списку користувачів' }));
      } else {
        const users = rows.map((row) => row.username);
        ws.send(JSON.stringify({ action: 'loadUserList', success: true, users }));
      }
    });
  });
}

// Отримання профілю користувача (перевірка UUID)
function handleGetProfile(ws, username, providedUuid) {
  verifyUuid(ws, username, providedUuid, () => {
    db.get('SELECT about FROM profiles WHERE username = ?', [username], (err, row) => {
      if (err) {
        ws.send(JSON.stringify({ action: 'get_profile', success: false, message: 'Помилка завантаження профілю' }));
      } else if (row) {
        ws.send(JSON.stringify({ action: 'get_profile', success: true, about: row.about }));
      } else {
        ws.send(JSON.stringify({ action: 'get_profile', success: true, about: '' }));
      }
    });
  });
}

// Оновлення профілю (перевірка UUID)
function handleUpdateProfile(ws, username, about, providedUuid) {
  verifyUuid(ws, username, providedUuid, () => {
    db.run('UPDATE profiles SET about = ? WHERE username = ?', [about, username], function (err) {
      if (err) {
        ws.send(JSON.stringify({ action: 'update_profile', success: false, message: 'Помилка оновлення профілю' }));
      } else {
        ws.send(JSON.stringify({ action: 'update_profile', success: true, about }));
      }
    });
  });
}

// Вихід з акаунту (перевірка UUID)
function handleLogout(ws, username, providedUuid) {
  verifyUuid(ws, username, providedUuid, () => {
    if (onlineUsers.has(username)) {
      onlineUsers.delete(username);
      ws.send(JSON.stringify({ action: 'logout', success: true, message: 'Ви вийшли' }));
      broadcastOnlineStatus();
    }
  });
}

// Обробка відключення користувача
function handleUserDisconnect(ws) {
  if (ws.username && onlineUsers.has(ws.username)) {
    onlineUsers.delete(ws.username);
    broadcastOnlineStatus();
  }
}

// Розсилка інформації про онлайн користувачів
function broadcastOnlineStatus() {
  const users = Array.from(onlineUsers.keys());
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ action: 'online_users', users }));
    }
  });
}

// Отримання списку онлайн користувачів (перевірка UUID)
function handleGetOnlineUsers(ws, providedUuid) {
  if (!ws.username) {
    ws.send(JSON.stringify({ action: 'online_users', success: false, message: 'Користувач не авторизований' }));
    return;
  }
  verifyUuid(ws, ws.username, providedUuid, () => {
    const users = Array.from(onlineUsers.keys());
    ws.send(JSON.stringify({ action: 'online_users', users }));
  });
}

// Обробка виклику (перевірка UUID)
function handleCall(ws, caller, providedUuid, recipient) {
  verifyUuid(ws, caller, providedUuid, () => {
    if (!onlineUsers.has(recipient)) {
      ws.send(JSON.stringify({ action: 'call', success: false, message: 'Користувач не в мережі' }));
      return;
    }
    const recipientWs = onlineUsers.get(recipient);
    recipientWs.send(JSON.stringify({ action: 'incoming_call', caller }));
    db.run('INSERT INTO calls (caller, recipient, status) VALUES (?, ?, ?)', [caller, recipient, 'missed']);
  });
}

// Обробка відповіді на виклик (перевірка UUID)
function handleAnswerCall(ws, caller, recipient, providedUuid) {
  verifyUuid(ws, recipient, providedUuid, () => {
    db.run(
      `UPDATE calls SET status = ? WHERE id = (
        SELECT id FROM calls WHERE caller = ? AND recipient = ? ORDER BY timestamp DESC LIMIT 1
      )`,
      ['answered', caller, recipient],
      (err) => {
        if (err) {
          console.error(err);
        }
      }
    );
    const callerWs = onlineUsers.get(caller);
    if (callerWs) {
      callerWs.send(JSON.stringify({ action: 'call_answered', recipient }));
    }
    ws.send(JSON.stringify({ action: 'call_answered', caller }));
  });
}

// Обробка відхилення виклику (перевірка UUID)
function handleDeclineCall(ws, caller, recipient, providedUuid) {
  verifyUuid(ws, recipient, providedUuid, () => {
    db.run(
      `UPDATE calls SET status = ? WHERE id = (
        SELECT id FROM calls WHERE caller = ? AND recipient = ? ORDER BY timestamp DESC LIMIT 1
      )`,
      ['declined', caller, recipient],
      (err) => {
        if (err) {
          console.error(err);
        }
      }
    );
    const callerWs = onlineUsers.get(caller);
    if (callerWs) {
      callerWs.send(JSON.stringify({ action: 'call_declined', recipient }));
    }
    ws.send(JSON.stringify({ action: 'call_declined', caller }));
  });
}

// Завантаження історії дзвінків (перевірка UUID)
function handleLoadCallHistory(ws, username, providedUuid) {
  verifyUuid(ws, username, providedUuid, () => {
    db.all('SELECT * FROM calls WHERE caller = ? OR recipient = ? ORDER BY timestamp DESC', [username, username], (err, rows) => {
      if (err) {
        ws.send(JSON.stringify({ action: 'load_call_history', success: false, message: 'Помилка завантаження історії дзвінків' }));
      } else {
        ws.send(JSON.stringify({ action: 'load_call_history', success: true, callHistory: rows }));
      }
    });
  });
}

// Отримання активних банів (перевірка UUID)
function handleGetActiveBans(ws, providedUuid) {
  if (!ws.username) {
    ws.send(JSON.stringify({ action: 'get_active_bans', success: false, message: 'Користувач не авторизований' }));
    return;
  }
  verifyUuid(ws, ws.username, providedUuid, () => {
    const nowUnix = moment().unix();
    db.all('SELECT * FROM bans WHERE banned_until > ?', [nowUnix], (err, rows) => {
      if (err) {
        ws.send(JSON.stringify({ action: 'get_active_bans', success: false, message: 'Помилка завантаження активних банів' }));
      } else {
        ws.send(JSON.stringify({ action: 'get_active_bans', success: true, bans: rows }));
      }
    });
  });
}

// Запуск сервера
const PORT = 2573;
server.listen(PORT, () => {
  console.log(`Сервер запущено на порту ${PORT}`);
});
