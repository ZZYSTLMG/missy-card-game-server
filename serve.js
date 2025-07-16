// =================================================================================
// 小姐牌 - 后端服务器 (Node.js for Zeabur)
// =================================================================================

const WebSocket = require('ws');

// Zeabur 会自动注入 PORT 环境变量，我们直接使用它
const PORT = process.env.PORT || 8080;

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ port: PORT });

// 存储所有游戏房间的状态
const gameRooms = {};

// --- 游戏常量定义 ---
const SUITS = { '♠': 'black', '♥': 'red', '♣': 'black', '♦': 'red' };
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const JOKERS = [{rank: '小王', suit: '🃏', color: 'black'}, {rank: '大王', suit: '🃏', color: 'red'}];
const HOLDABLE_CARDS = ['7', '8', '小王'];

/**
 * 创建一副新牌并洗牌
 */
function createNewDeck() {
    const newDeck = [];
    const crypto = require('crypto');
    for (const suit in SUITS) {
        for (const rank of RANKS) {
            newDeck.push({ suit, rank, color: SUITS[suit], id: crypto.randomUUID() });
        }
    }
    JOKERS.forEach(joker => newDeck.push({...joker, id: crypto.randomUUID()}));
    for (let i = newDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
    }
    return newDeck;
}

/**
 * 向指定房间的所有玩家广播消息
 */
function broadcast(roomId, message) {
    if (!gameRooms[roomId]) return;

    const room = gameRooms[roomId];
    // 在广播前，创建一个不包含 ws 连接实例的 gameState 版本
    const stateToSend = { ...room, players: room.players.map(p => ({...p, ws: undefined})) };
    const messageToSend = { ...message, gameState: stateToSend };
    const messageString = JSON.stringify(messageToSend);

    room.players.forEach(player => {
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(messageString);
        }
    });
}

/**
 * 处理玩家加入游戏房间
 */
function handleJoinRoom(ws, roomId) {
    const room = gameRooms[roomId];
    if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: '房间不存在。' }));
        return;
    }

    if (room.players.some(p => p.ws === ws)) {
        console.log(`玩家 ${ws.userId} 已在房间 ${roomId} 中。`);
        return;
    }

    const newPlayer = {
        id: ws.userId,
        name: `玩家${ws.userId.substring(0, 4)}`,
        hand: [],
        ws: ws,
    };

    room.players.push(newPlayer);
    ws.roomId = roomId;

    console.log(`玩家 ${newPlayer.name} 加入了房间 ${roomId}。当前人数: ${room.players.length}`);
    broadcast(roomId, { type: 'gameStateUpdate' });
}


// --- WebSocket 服务器事件处理 ---
wss.on('connection', ws => {
    const crypto = require('crypto');
    ws.userId = crypto.randomUUID();
    console.log(`新玩家连接成功，ID: ${ws.userId}`);

    ws.send(JSON.stringify({ type: 'connected', userId: ws.userId }));

    ws.on('message', messageString => {
        try {
            const message = JSON.parse(messageString);
            const roomId = ws.roomId;
            const room = gameRooms[roomId];

            switch (message.type) {
                case 'createRoom':
                    const newRoomId = Math.random().toString(36).substring(2, 7).toUpperCase();
                    gameRooms[newRoomId] = {
                        roomId: newRoomId,
                        hostId: ws.userId,
                        players: [],
                        deck: createNewDeck(),
                        currentPlayerIndex: 0,
                        lastDrawnCard: null,
                        gameLog: [`游戏由 玩家${ws.userId.substring(0, 4)} 创建。`],
                        roles: { emperor: null, missies: [], servants: [] },
                        isGameOver: false,
                    };
                    console.log(`房间 ${newRoomId} 已创建。`);
                    handleJoinRoom(ws, newRoomId);
                    break;

                case 'joinRoom':
                    handleJoinRoom(ws, message.roomId);
                    break;

                case 'drawCard':
                    if (room && room.players[room.currentPlayerIndex]?.id === ws.userId && !room.isGameOver) {
                        const drawnCard = room.deck.pop();
                        if (!drawnCard) return;

                        const currentPlayer = room.players[room.currentPlayerIndex];
                        let logMessage = `${currentPlayer.name} 抽到了 ${drawnCard.suit}${drawnCard.rank}。`;

                        if (HOLDABLE_CARDS.includes(drawnCard.rank)) {
                            currentPlayer.hand.push(drawnCard);
                            logMessage += ` 卡牌已存入手牌。`;
                        } else {
                            const rank = drawnCard.rank;
                            if (rank === 'K') room.roles.emperor = currentPlayer.id;
                            if (rank === 'Q' && !room.roles.missies.includes(currentPlayer.id)) room.roles.missies.push(currentPlayer.id);
                            if (rank === 'J' && !room.roles.servants.includes(currentPlayer.id)) room.roles.servants.push(currentPlayer.id);
                        }

                        room.lastDrawnCard = drawnCard;
                        room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
                        room.gameLog.push(logMessage);
                        if (room.deck.length === 0) {
                            room.isGameOver = true;
                            room.gameLog.push('牌堆已空！游戏结束。');
                        }
                        broadcast(roomId, { type: 'gameStateUpdate' });
                    }
                    break;
            }
        } catch (error) {
            console.error("处理消息时出错:", error);
        }
    });

    ws.on('close', () => {
        console.log(`玩家 ${ws.userId} 断开连接。`);
        const roomId = ws.roomId;
        if (!roomId || !gameRooms[roomId]) return;

        const room = gameRooms[roomId];
        room.players = room.players.filter(player => player.id !== ws.userId);

        if (room.players.length === 0) {
            console.log(`房间 ${roomId} 已空，将被删除。`);
            delete gameRooms[roomId];
        } else {
            if (room.hostId === ws.userId) {
                room.hostId = room.players[0].id;
            }
            if (room.currentPlayerIndex >= room.players.length) {
                room.currentPlayerIndex = 0;
            }
            broadcast(roomId, { type: 'gameStateUpdate' });
        }
    });
});

console.log(`小姐牌游戏服务器已启动，正在监听端口 ${PORT}`);
