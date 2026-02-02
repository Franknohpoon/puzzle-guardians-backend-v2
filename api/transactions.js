// 프론트엔드용 API - DB에서 빠르게 조회
const { sql } = require('@vercel/postgres');

module.exports = async (req, res) => {
  // CORS 헤더
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    console.log('📊 트랜잭션 조회 중...');

    // DB에서 실제 트랜잭션만 조회 (MARKER 제외, 최신순)
    const result = await sql`
      SELECT 
        tx_hash,
        block_number,
        timestamp,
        to_address,
        amount,
        token
      FROM transactions
      WHERE token != 'MARKER'
      ORDER BY timestamp DESC
    `;

    console.log(`✅ ${result.rows.length}개 조회 완료`);

    // 데이터 변환
    const transactions = result.rows.map(row => ({
      txHash: row.tx_hash,
      blockNumber: parseInt(row.block_number),
      timestamp: parseInt(row.timestamp) * 1000, // 밀리초로 변환
      to: row.to_address,
      amount: parseFloat(row.amount),
      token: row.token
    }));

    return res.status(200).json({
      success: true,
      count: transactions.length,
      transactions: transactions
    });

  } catch (error) {
    console.error('❌ 조회 실패:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
