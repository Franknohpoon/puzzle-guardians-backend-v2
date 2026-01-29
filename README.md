# Puzzle & Guardians Backend v2
**Vercel Postgres + Cron Jobs**

## 🏗️ 구조

```
⏰ Cron (5분마다)
  ↓
/api/sync - 새 데이터 수집 → Postgres DB 저장
  ↓
/api/transactions - 프론트엔드가 빠르게 조회
```

---

## 🚀 배포 가이드

### Step 1: Vercel에 배포

1. 기존 프로젝트 삭제 또는 새 프로젝트 생성
2. GitHub 저장소 연결
3. **Deploy** 클릭

---

### Step 2: Vercel Postgres 설정

1. Vercel 프로젝트 → **Storage** 탭
2. **Create Database** → **Postgres** 선택
3. 무료 플랜 선택
4. 자동으로 환경 변수 생성됨 ✅

---

### Step 3: CRON_SECRET 환경 변수 추가

1. **Settings** → **Environment Variables**
2. **Add New**
   - Name: `CRON_SECRET`
   - Value: 강력한 랜덤 문자열 (예: `sk_live_abc123xyz789`)
3. **Save**

**중요**: 이 값을 꼭 복사해두세요!

---

### Step 4: Cron 활성화

1. **Settings** → **Cron Jobs**
2. 자동으로 활성화됨 (vercel.json에 정의됨)
3. 확인: `/api/sync` - 5분마다 실행

---

### Step 5: 첫 데이터 수집 (수동 실행)

브라우저에서:
```
https://your-project.vercel.app/api/sync
Headers: Authorization: Bearer YOUR_CRON_SECRET
```

또는 curl:
```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
  https://your-project.vercel.app/api/sync
```

**5~10분 정도 소요됩니다!**

---

### Step 6: 프론트엔드 테스트

```
https://your-project.vercel.app/api/transactions
```

JSON 데이터가 나오면 성공! ✅

---

## 📊 API 엔드포인트

### GET /api/transactions
프론트엔드용 - DB에서 빠르게 조회

**응답:**
```json
{
  "success": true,
  "count": 224,
  "transactions": [...]
}
```

### POST /api/sync
Cron 작업 - 새 데이터 수집

**헤더:**
```
Authorization: Bearer YOUR_CRON_SECRET
```

---

## ⏰ 자동 업데이트

- **5분마다** 자동으로 새 데이터 수집
- 중복 데이터는 자동 무시
- 최대 50,000 블록씩 처리

---

## 🔍 로그 확인

Vercel 대시보드 → **Logs** 탭

```
🔄 Cron 작업 시작...
📦 조회 범위: 12345 ~ 12350
✅ 총 5개 로그 발견
💾 5개 저장 완료
```

---

## 💡 프론트엔드 수정

`index.html`의 API URL을 변경:
```javascript
const API_URL = 'https://your-project.vercel.app/api/transactions';
```

---

## 📈 무료 플랜 제한

- **Postgres**: 256MB, 60시간 compute/월
- **Cron**: 무제한
- **Functions**: 100GB-hours/월

충분히 사용 가능합니다! ✅
