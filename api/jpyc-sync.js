// api/jpyc-sync.js
// Unifi JPYC 미션 데이터 동기화
// 온체인 JPYC Transfer 로그를 Kaia RPC에서 직접 읽어 저장 (api/sync.js 와 동일한 방식)

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
// 한 번에 조회할 블록 범위
const CHUNK_SIZE = 500000;

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
function identifyMission(tx) {
    const amount = parseFloat(tx.amount);
    const timestamp = new Date(tx.timestamp);

    // 200 JPYC = 덱 전투력 6666
    if (amount === 200) {
        return MISSIONS.POWER6666;
    }

    // 50 JPYC = Phase 2 (7/2 12:00 이후)
    if (amount === 50 && timestamp >= MISSIONS.LEVEL5_PHASE2.startDate) {
        return MISSIONS.LEVEL5_PHASE2;
    }

    // 10 JPYC = Phase 1 (7/2 12:00 이전)
    if (amount === 10 && timestamp < MISSIONS.LEVEL5_PHASE2.startDate) {
        return MISSIONS.LEVEL5_PHASE1;
    }

    return null;
}

module.exports = async (req, res) => {
    try {
        // CORS 헤더
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');

        console.log('🚀 JPYC 미션 동기화 시작...');

        // 테이블 생성 (없으면)
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

        // 인덱스 생성
        await sql`CREATE INDEX IF NOT EXISTS idx_jpyc_to ON jpyc_transactions(to_address)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_jpyc_mission ON jpyc_transactions(mission_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_jpyc_timestamp ON jpyc_transactions(timestamp)`;

        // 마지막 동기화 블록 확인
        const lastBlockResult = await sql`
            SELECT MAX(block_number) as max_block FROM jpyc_transactions
        `;
        const fromBlock = lastBlockResult.rows[0]?.max_block
            ? parseInt(lastBlockResult.rows[0].max_block) + 1
            : INITIAL_BLOCK;

        const provider = new ethers.providers.JsonRpcProvider(KAIA_RPC);
        const latestBlock = await provider.getBlockNumber();

        console.log(`📍 조회 범위: ${fromBlock} ~ ${latestBlock}`);

        if (fromBlock > latestBlock) {
            const stats = await getStats();
            return res.status(200).json({
                success: true,
                totalSynced: 0,
                message: '새 블록 없음',
                missions: stats,
                timestamp: new Date().toISOString()
            });
        }

        // JPYC Transfer 로그 조회 (from = 지급 지갑) — 500k 블록씩
        const allLogs = [];
        for (let currentFrom = fromBlock; currentFrom <= latestBlock; currentFrom += CHUNK_SIZE) {
            const currentTo = Math.min(currentFrom + CHUNK_SIZE - 1, latestBlock);
            try {
                const logs = await provider.getLogs({
                    fromBlock: currentFrom,
                    toBlock: currentTo,
                    address: JPYC_TOKEN_ADDRESS,
                    topics: [
                        TRANSFER_TOPIC,
                        ethers.utils.hexZeroPad(JPYC_WALLET, 32), // from (지급 지갑)
                        null // to (any user)
                    ]
                });
                allLogs.push(...logs);
                console.log(`  블록 ${currentFrom}~${currentTo}: ${logs.length}개`);
            } catch (error) {
                console.warn(`  블록 조회 실패 (${currentFrom}~${currentTo}):`, error.message);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        console.log(`✅ 총 ${allLogs.length}개 Transfer 로그 발견`);

        // 블록 타임스탬프 조회 (동시성 배치로 캐시)
        const uniqueBlocks = [...new Set(allLogs.map(l => l.blockNumber))];
        const blockTs = {};
        const BATCH = 12;
        for (let i = 0; i < uniqueBlocks.length; i += BATCH) {
            const batch = uniqueBlocks.slice(i, i + BATCH);
            const results = await Promise.all(
                batch.map(bn => provider.getBlock(bn).catch(() => null))
            );
            batch.forEach((bn, idx) => {
                if (results[idx]) blockTs[bn] = results[idx].timestamp; // seconds
            });
        }

        // 저장
        let totalSynced = 0;
        for (const log of allLogs) {
            try {
                const tsSec = blockTs[log.blockNumber];
                if (!tsSec) continue; // 타임스탬프 조회 실패 건은 스킵 (다음 동기화 때 재시도)

                const amount = parseFloat(ethers.utils.formatEther(log.data)); // 18 decimals
                const to = ethers.utils.getAddress('0x' + log.topics[2].slice(26)).toLowerCase();
                const timestampMs = tsSec * 1000; // 프론트/미션 분류가 ms 기준

                const mission = identifyMission({ amount, timestamp: timestampMs });

                await sql`
                    INSERT INTO jpyc_transactions
                    (tx_hash, from_address, to_address, amount, block_number, timestamp, mission_id, mission_name)
                    VALUES (
                        ${log.transactionHash},
                        ${JPYC_WALLET.toLowerCase()},
                        ${to},
                        ${amount},
                        ${log.blockNumber},
                        ${timestampMs},
                        ${mission?.id || null},
                        ${mission?.name || null}
                    )
                    ON CONFLICT (tx_hash) DO NOTHING
                `;
                totalSynced++;
            } catch (err) {
                console.error(`❌ Insert 오류: ${err.message}`);
            }
        }

        const stats = await getStats();

        return res.status(200).json({
            success: true,
            fromBlock,
            toBlock: latestBlock,
            logsFound: allLogs.length,
            totalSynced,
            missions: stats,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Sync 오류:', error);
        return res.status(500).json({
            error: error.message,
            stack: error.stack
        });
    }
};

// 미션별 통계
async function getStats() {
    const stats = await sql`
        SELECT
            mission_id,
            mission_name,
            COUNT(*) as claim_count,
            COUNT(DISTINCT to_address) as unique_users,
            SUM(amount) as total_paid
        FROM jpyc_transactions
        WHERE mission_id IS NOT NULL
        GROUP BY mission_id, mission_name
    `;
    return stats.rows;
}
