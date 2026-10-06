// 삼성 인터넷은 설치 정보에 '파일 공유로 받기'(POST share_target)가 있으면 앱 설치가 "다운로드하지 못했습니다"로 실패한다.
// 그래서 삼성 인터넷에는 그것만 뺀 설치 정보(stamp.py가 manifest.webmanifest에서 만든다)를 준다.
// 페이지 보안 규칙(CSP)이 인라인 스크립트를 막아 따로 둔 파일 — 설치 정보를 읽기 전에 돌도록 <head>에서 바로 부른다.
if (/SamsungBrowser/i.test(navigator.userAgent)) {
  document.querySelector('link[rel="manifest"]').href = 'manifest-samsung.webmanifest';
}
