// api/jpyc-sync.js
// Unifi JPYC 미션 데이터 동기화
// 온체인 JPYC Transfer 로그를 Kaia RPC(raw JSON-RPC)에서 직접 읽어 저장

const { ethers } = require('ethers');
const { sql } = require('@vercel/postgres');

// JPYC 보상 지급 지갑
const JPYC_WALLET = '0x2a1e3ac1aecd1b9a898ae705ef2b9ccffb955bba';
// JPYC 토큰 컨트랙트 (Kaia) — symbol=JPYC, name=JPY Coin, decimals=18 (온체인 확인)
const JPYC_TOKEN_ADDRESS = '0xe7c3d8c9a439fede00d2600032d5db0be71c3c29';
// 작동하는 Kaia 공개 RPC (env 로 override 가능)
const KAIA_RPC = process.env.KAIA_RPC || 'https://public-en.node.kaia.io';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// 첫 지급 블록(219,669,879) 직전 — 최초 동기화 시작점
const INITIAL_BLOCK = 219600000;
const LOG_CHUNK = 300000;   // getLogs 한 번에 조회할 블록 범위
const TS_BATCH = 100;       // 블록 타임스탬프 배치 요청 크기
const INSERT_BATCH = 200;   // 벌크 INSERT 행 수
const MAX_BLOCKS_PER_RUN = 2000000; // 한 호출당 처리 상한 (안전장치)

// 미션 정의
const MISSIONS = {
    LEVEL5_PHASE1: {
        id: 'level5-phase1',
        name: '계정레벨 5 달성 (Phase 1)',
        reward: 10,
        startDate: new Date('2026-06-20T00:00:00+09:00'),
        endDate: new Date('2026-07-02T12:00:00+09:00')
    },
    LEVEL5_PHASE2: {
        id: 'level5-phase2',
        name: '계정레벨 5 달성 (Phase 2)',
        reward: 50,
        startDate: new Date('2026-07-02T12:00:00+09:00'),
        endDate: new Date('2026-07-09T12:00:00+09:00')
    },
    POWER6666: {
        id: 'power-6666',
        name: '덱 전투력 6666 달성',
        reward: 200,
        startDate: new Date('2026-06-20T00:00:00+09:00'),
        endDate: new Date('2026-12-31T23:59:59+09:00')
    }
};

// 트랜잭션을 미션으로 분류 (timestamp: ms epoch)
function identifyMission(amount, timestampMs) {
    const t = new Date(timestampMs);
    if (amount === 200) return MISSIONS.POWER6666;
    if (amount === 50 && t >= MISSIONS.LEVEL5_PHASE2.startDate) return MISSIONS.LEVEL5_PHASE2;
    if (amount === 10 && t < MISSIONS.LEVEL5_PHASE2.startDate) return MISSIONS.LEVEL5_PHASE1;
    return null;
}

// raw JSON-RPC 호출 (타임아웃/재시도 제어)
async function rpc(method, params, timeoutMs = 20000) {
    return rpcBatch([{ method, params, id: 1 }], timeoutMs).then(r => r[0]);
}

async function rpcBatch(calls, timeoutMs = 30000) {
    const body = calls.map((c, i) => ({
        jsonrpc: '2.0',
        id: c.id ?? i,
        method: c.method,
        params: c.params
    }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(KAIA_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!resp.ok) throw new Error(`RPC HTTP ${resp.status}`);
        const json = await resp.json();
        const arr = Array.isArray(json) ? json : [json];
        // id 순서 보장
        const byId = {};
        for (const r of arr) byId[r.id] = r;
        return body.map(b => byId[b.id]?.result ?? null);
    } finally {
        clearTimeout(timer);
    }
}

module.exports = async (req, res) => {
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');

        console.log('🚀 JPYC 미션 동기화 시작...');

        // 테이블 / 인덱스
        await sql`
            CREATE TABLE IF NOT EXISTS jpyc_transactions (
                id SERIAL PRIMARY KEY,
                tx_hash VARCHAR(66) UNIQUE NOT NULL,
                from_address VARCHAR(42) NOT NULL,
                to_address VARCHAR(42) NOT NULL,
                amount DECIMAL(20, 6) NOT NULL,
                token VARCHAR(10) DEFAULT 'JPYC',
                block_number BIGINT NOT NULL,
                timestamp BIGINT NOT NULL,
                mission_id VARCHAR(50),
                mission_name VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;
        await sql`CREATE INDEX IF NOT EXISTS idx_jpyc_to ON jpyc_transactions(to_address)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_jpyc_mission ON jpyc_transactions(mission_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_jpyc_timestamp ON jpyc_transactions(timestamp)`;

        // 미션 외 송금(미분류)은 저장하지 않음 — 과거에 저장된 미분류 행 정리
        await sql`DELETE FROM jpyc_transactions WHERE mission_id IS NULL`;

        // 시작 블록
        const lastBlockResult = await sql`SELECT MAX(block_number) as max_block FROM jpyc_transactions`;
        const fromBlock = lastBlockResult.rows[0]?.max_block
            ? parseInt(lastBlockResult.rows[0].max_block) + 1
            : INITIAL_BLOCK;

        const latestHex = await rpc('eth_blockNumber', []);
        const latestBlock = parseInt(latestHex, 16);
        const toBlock = Math.min(fromBlock + MAX_BLOCKS_PER_RUN - 1, latestBlock);

        console.log(`📍 조회 범위: ${fromBlock} ~ ${toBlock} (latest ${latestBlock})`);

        if (fromBlock > latestBlock) {
            return res.status(200).json({
                success: true, totalSynced: 0, message: '새 블록 없음',
                missions: await getStats(), timestamp: new Date().toISOString()
            });
        }

        // 1) getLogs (from = 지급 지갑) — LOG_CHUNK 씩
        const fromTopic = ethers.utils.hexZeroPad(JPYC_WALLET, 32);
        const allLogs = [];
        for (let cf = fromBlock; cf <= toBlock; cf += LOG_CHUNK) {
            const ct = Math.min(cf + LOG_CHUNK - 1, toBlock);
            const logs = await rpc('eth_getLogs', [{
                fromBlock: '0x' + cf.toString(16),
                toBlock: '0x' + ct.toString(16),
                address: JPYC_TOKEN_ADDRESS,
                topics: [TRANSFER_TOPIC, fromTopic, null]
            }], 40000);
            if (Array.isArray(logs)) allLogs.push(...logs);
            console.log(`  블록 ${cf}~${ct}: ${Array.isArray(logs) ? logs.length : 'ERR'}개`);
        }
        console.log(`✅ 총 ${allLogs.length}개 Transfer 로그`);

        // 2) 블록 타임스탬프 배치 조회
        const uniqueBlocks = [...new Set(allLogs.map(l => l.blockNumber))]; // hex 문자열
        const blockTs = {};
        for (let i = 0; i < uniqueBlocks.length; i += TS_BATCH) {
            const batch = uniqueBlocks.slice(i, i + TS_BATCH);
            const results = await rpcBatch(
                batch.map((bn, idx) => ({ method: 'eth_getBlockByNumber', params: [bn, false], id: idx })),
                40000
            );
            batch.forEach((bn, idx) => {
                const blk = results[idx];
                if (blk && blk.timestamp) blockTs[bn] = parseInt(blk.timestamp, 16); // seconds
            });
        }

        // 3) 행 구성
        const rows = [];
        for (const log of allLogs) {
            const tsSec = blockTs[log.blockNumber];
            if (!tsSec) continue;
            const amount = parseFloat(ethers.utils.formatUnits(ethers.BigNumber.from(log.data), 18));
            const to = ('0x' + log.topics[2].slice(26)).toLowerCase();
            const timestampMs = tsSec * 1000;
            const mission = identifyMission(amount, timestampMs);
            if (!mission) continue; // 미션 해당 금액(10/50/200)만 저장
            rows.push([
                log.transactionHash,
                JPYC_WALLET.toLowerCase(),
                to,
                amount,
                parseInt(log.blockNumber, 16),
                timestampMs,
                mission?.id || null,
                mission?.name || null
            ]);
        }

        // 4) 벌크 INSERT (INSERT_BATCH 행씩)
        let totalSynced = 0;
        for (let i = 0; i < rows.length; i += INSERT_BATCH) {
            const batch = rows.slice(i, i + INSERT_BATCH);
            const values = [];
            const placeholders = batch.map((r, ri) => {
                const b = ri * 8;
                values.push(...r);
                return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
            }).join(',');
            const text = `
                INSERT INTO jpyc_transactions
                (tx_hash, from_address, to_address, amount, block_number, timestamp, mission_id, mission_name)
                VALUES ${placeholders}
                ON CONFLICT (tx_hash) DO NOTHING
            `;
            try {
                const r = await sql.query(text, values);
                totalSynced += r.rowCount || 0;
            } catch (err) {
                console.error(`❌ Bulk insert 오류: ${err.message}`);
            }
        }

        console.log(`💾 ${totalSynced}건 저장`);

        return res.status(200).json({
            success: true,
            fromBlock,
            toBlock,
            latestBlock,
            logsFound: allLogs.length,
            totalSynced,
            missions: await getStats(),
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Sync 오류:', error);
        return res.status(500).json({ error: error.message, stack: error.stack });
    }
};

async function getStats() {
    const stats = await sql`
        SELECT mission_id, mission_name,
               COUNT(*) as claim_count,
               COUNT(DISTINCT to_address) as unique_users,
               SUM(amount) as total_paid
        FROM jpyc_transactions
        WHERE mission_id IS NOT NULL
        GROUP BY mission_id, mission_name
    `;
    return stats.rows;
}
