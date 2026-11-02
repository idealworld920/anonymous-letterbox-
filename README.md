# 익명의 속마음 편지함 💌

> 차마 말하지 못했던 진심을 익명으로 보내세요.

닉네임 생성 → 받는 사람·편지 작성 → 링크 공유 → 전송·공유 현황 확인.
Express + Firestore(firebase-admin). 로컬에서는 Firebase 설정 없이도 JSON 파일로 동작합니다.

## 로컬 실행
```bash
npm install
npm start        # http://localhost:3000
```

## Render 배포
1. 이 레포를 Render에 **Web Service**로 연결 (`render.yaml` 자동 인식)
2. 환경변수 설정
   - `FIREBASE_SERVICE_ACCOUNT` — 서비스 계정 JSON 전체 (오브이안과 동일한 값 재사용 가능)
   - `FIRESTORE_DATABASE_ID` — 이름 있는 Firestore DB를 쓸 때만 (오브이안 프로젝트: `ai-studio-f51ac51b-bcfa-4234-9f4b-98d33ba7f529`)
3. 배포 후 `/healthz` 가 `ok` 를 반환하면 완료

Firestore 컬렉션: `letterbox_letters` (현황 조회용 복합 인덱스 `senderToken ASC, createdAt DESC` 가 필요하면 첫 조회 시 로그에 생성 링크가 출력됩니다)

## API
| Method | Path | 설명 |
|---|---|---|
| POST | `/api/letters` | 편지 봉인 `{to,text,nick,senderToken}` → `{code}` |
| GET | `/api/letters/:code?view=1` | 편지 읽기 (보낸이 본인이면 열람수 미증가) |
| GET | `/api/status` | 내가 보낸 편지 현황 (`x-sender-token` 헤더) |
