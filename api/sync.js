// Vercel Cron Job - 매일 실행
// 새로운 트랜잭션을 DB에 저장

const { ethers } = require('ethers');
const { sql } = require('@vercel/postgres');

const WALLET_ADDRESS = '0x3156f02e943cefb0247283b7f89b4ebf91133cff';
const BORA_TOKEN_ADDRESS = '0x02cbe46fb8a1f579254a9b485788f2d86cad51aa';
const KAIA_RPC = 'https://kaia.blockpi.network/v1/rpc/public';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

module.exports = async (req, res) => {
  // Cron secret 검증 (보안)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('🔄 Cron 작업 시작...');

    // 테이블 생성 (없으면)
    await sql`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        tx_hash VARCHAR(66) UNIQUE NOT NULL,
        block_number BIGINT NOT NULL,
        timestamp BIGINT NOT NULL,
        from_address VARCHAR(42) NOT NULL,
        to_address VARCHAR(42) NOT NULL,
        amount DECIMAL(36, 18) NOT NULL,
        token VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // 인덱스 생성 (없으면)
    await sql`
      CREATE INDEX IF NOT EXISTS idx_timestamp ON transactions(timestamp)
    `;
    
    await sql`
      CREATE INDEX IF NOT EXISTS idx_tx_hash ON transactions(tx_hash)
    `;

    // 마지막으로 저장된 블록 번호 조회
    const lastBlockResult = await sql`
      SELECT MAX(block_number) as last_block FROM transactions
    `;
    
    let fromBlock;
    if (lastBlockResult.rows[0].last_block) {
      fromBlock = parseInt(lastBlockResult.rows[0].last_block) + 1;
      console.log(`📦 마지막 블록: ${lastBlockResult.rows[0].last_block}, 시작: ${fromBlock}`);
    } else {
      // 처음 실행 - 최초 퀘스트 보상 지급 블록 (199653361)
      fromBlock = 199653361;
      console.log(`🆕 처음 실행 - 시작 블록: ${fromBlock}`);
    }

    const provider = new ethers.providers.JsonRpcProvider(KAIA_RPC);
    const latestBlock = await provider.getBlockNumber();

    console.log(`📦 조회 범위: ${fromBlock} ~ ${latestBlock}`);

    // 최대 500,000 블록까지 (약 6일치)
    const toBlock = Math.min(fromBlock + 500000, latestBlock);

    // 5000 블록씩 나눠서 조회
    const CHUNK_SIZE = 5000;
    const allLogs = [];
    
    for (let currentFrom = fromBlock; currentFrom <= toBlock; currentFrom += CHUNK_SIZE) {
      const currentTo = Math.min(currentFrom + CHUNK_SIZE - 1, toBlock);
      
      try {
        const logs = await provider.getLogs({
          fromBlock: currentFrom,
          toBlock: currentTo,
          address: BORA_TOKEN_ADDRESS,
          topics: [
            TRANSFER_TOPIC,
            ethers.utils.hexZeroPad(WALLET_ADDRESS, 32), // from (우리 지갑)
            null // to (any user)
          ]
        });
        
        allLogs.push(...logs);
        console.log(`  블록 ${currentFrom}~${currentTo}: ${logs.length}개`);
      } catch (error) {
        console.warn(`  블록 조회 실패:`, error.message);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log(`✅ 총 ${allLogs.length}개 로그 발견`);

    // 블록 캐시
    const blockCache = {};
    let savedCount = 0;
    
    // 트랜잭션 처리 및 저장
    for (const log of allLogs) {
      try {
        // 블록 정보 조회
        if (!blockCache[log.blockNumber]) {
          blockCache[log.blockNumber] = await provider.getBlock(log.blockNumber);
        }
        const block = blockCache[log.blockNumber];
        
        const amount = ethers.utils.formatEther(log.data);
        const from = ethers.utils.getAddress('0x' + log.topics[1].slice(26));
        const to = ethers.utils.getAddress('0x' + log.topics[2].slice(26));
        
        // DB에 저장 (중복 무시)
        await sql`
          INSERT INTO transactions (
            tx_hash, block_number, timestamp, from_address, to_address, amount, token
          )
          VALUES (
            ${log.transactionHash},
            ${log.blockNumber},
            ${block.timestamp},
            ${WALLET_ADDRESS.toLowerCase()},
            ${to.toLowerCase()},
            ${amount},
            'BORA'
          )
          ON CONFLICT (tx_hash) DO NOTHING
        `;
        
        savedCount++;
      } catch (error) {
        console.warn('트랜잭션 저장 실패:', error.message);
      }
    }
    
    console.log(`💾 ${savedCount}개 저장 완료`);

    return res.status(200).json({
      success: true,
      fromBlock,
      toBlock,
      logsFound: allLogs.length,
      saved: savedCount
    });

  } catch (error) {
    console.error('❌ Cron 작업 실패:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
