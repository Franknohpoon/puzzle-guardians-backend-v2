// api/jpyc-transactions.js
// JPYC 미션 트랜잭션 조회 API

const { sql } = require('@vercel/postgres');

module.exports = async (req, res) => {
    try {
        // CORS 헤더
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET');
        
        // 전체 트랜잭션 조회
        const transactions = await sql`
            SELECT 
                tx_hash,
                from_address,
                to_address,
                amount,
                token,
                block_number,
                timestamp,
                mission_id,
                mission_name
            FROM jpyc_transactions
            ORDER BY timestamp DESC
            LIMIT 5000
        `;
        
        // 미션별 통계
        const missionStats = await sql`
            SELECT 
                mission_id,
                mission_name,
                COUNT(*) as claim_count,
                COUNT(DISTINCT to_address) as unique_users,
                SUM(amount) as total_paid,
                MIN(timestamp) as first_claim,
                MAX(timestamp) as last_claim
            FROM jpyc_transactions
            WHERE mission_id IS NOT NULL
            GROUP BY mission_id, mission_name
            ORDER BY mission_id
        `;
        
        // 전체 통계
        const totalStats = await sql`
            SELECT 
                COUNT(*) as total_transactions,
                COUNT(DISTINCT to_address) as unique_users,
                SUM(amount) as total_paid
            FROM jpyc_transactions
        `;
        
        // 중복 참여 유저 (두 미션 모두 참여한 유저)
        const crossParticipation = await sql`
            SELECT 
                to_address,
                COUNT(DISTINCT mission_id) as mission_count,
                SUM(amount) as total_earned,
                array_agg(DISTINCT mission_name) as missions
            FROM jpyc_transactions
            WHERE mission_id IS NOT NULL
            GROUP BY to_address
            HAVING COUNT(DISTINCT mission_id) > 1
            ORDER BY total_earned DESC
        `;
        
        return res.status(200).json({
            success: true,
            transactions: transactions.rows,
            missionStats: missionStats.rows,
            totalStats: totalStats.rows[0],
            crossParticipation: crossParticipation.rows,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ 조회 오류:', error);
        return res.status(500).json({
            error: error.message
        });
    }
};
