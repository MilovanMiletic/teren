/**
 * The card at the head of each scene: TEREN, one Serbian line saying who we are watching, and
 * the device class. Written as a file into the served build so it comes from the recording origin
 * — same document, same video, no second context.
 *
 * Colours are `design/tokens.md`: canvas `#EFEDE8`, ink `#1A1A1A`, ink-2 `#5F5B52`, accent
 * `#E8674A`, accent-deep `#C2410C`. The font stack is the app's own.
 */
export function titleCardHtml({ eyebrow, title, body }) {
  return `<!doctype html>
<html lang="sr-Latn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #EFEDE8;
    color: #1A1A1A;
    font-family: 'IBM Plex Sans', Arial, sans-serif;
    display: grid;
    place-items: center;
    overflow: hidden;
  }
  .card {
    width: min(78vw, 760px);
    text-align: center;
    animation: rise 620ms cubic-bezier(.2,.7,.3,1) both;
  }
  .word {
    font-size: clamp(22px, 3.4vw, 40px);
    font-weight: 700;
    letter-spacing: 0.42em;
    text-indent: 0.42em;
    margin: 0 0 6px;
  }
  .rule {
    width: 64px;
    height: 4px;
    border-radius: 2px;
    background: #E8674A;
    margin: 0 auto clamp(26px, 5vh, 54px);
  }
  .eyebrow {
    font-size: clamp(11px, 1.3vw, 14px);
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #C2410C;
    margin: 0 0 14px;
  }
  h1 {
    font-size: clamp(26px, 4.2vw, 52px);
    line-height: 1.14;
    font-weight: 600;
    margin: 0;
  }
  p {
    font-size: clamp(14px, 1.7vw, 21px);
    line-height: 1.5;
    color: #5F5B52;
    margin: clamp(14px, 2.4vh, 24px) auto 0;
    max-width: 34ch;
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(14px); }
    to   { opacity: 1; transform: none; }
  }
</style>
</head>
<body>
  <div class="card">
    <p class="word">TEREN</p>
    <div class="rule"></div>
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
</body>
</html>
`;
}

/** The site photo the foreman "takes". A file input ignores the fake camera, so one is drawn. */
export const sitePhotoHtml = `<!doctype html>
<html lang="sr-Latn"><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden}
  body{
    background:
      radial-gradient(120% 80% at 30% 0%, rgba(255,255,255,.30), rgba(0,0,0,0) 60%),
      linear-gradient(184deg, #b9b3a6 0%, #a49d90 46%, #8d867a 100%);
    font-family: Arial, sans-serif;
  }
  .wall{position:absolute;inset:0;
    background-image:
      linear-gradient(90deg, rgba(0,0,0,.055) 0 2px, rgba(0,0,0,0) 2px 100%),
      linear-gradient(0deg, rgba(0,0,0,.05) 0 2px, rgba(0,0,0,0) 2px 100%);
    background-size: 190px 190px, 190px 95px;
  }
  .chase{position:absolute;top:0;bottom:0;width:186px;
    background:linear-gradient(90deg,rgba(0,0,0,.20),rgba(0,0,0,.06) 22%,rgba(0,0,0,.22));}
  .chase--a{left:22%} .chase--b{left:56%}
  .pipe{position:absolute;top:-6%;bottom:-6%;width:52px;border-radius:26px;}
  .pipe--hot{left:calc(22% + 34px);background:linear-gradient(90deg,#7f8c93,#c9d3d6 38%,#8b979d);}
  .pipe--cold{left:calc(22% + 100px);background:linear-gradient(90deg,#7f8c93,#c9d3d6 38%,#8b979d);}
  .pipe--riser{left:calc(56% + 66px);background:linear-gradient(90deg,#78858c,#bcc7cb 38%,#849096);}
  .cross{position:absolute;left:18%;right:14%;height:48px;top:58%;border-radius:24px;
    background:linear-gradient(180deg,#8b979d,#ccd6d9 40%,#7f8c93);}
  .floor{position:absolute;left:0;right:0;bottom:0;height:16%;
    background:linear-gradient(180deg,rgba(0,0,0,.16),rgba(0,0,0,.34));}
  .vig{position:absolute;inset:0;background:radial-gradient(75% 60% at 50% 42%,rgba(0,0,0,0),rgba(0,0,0,.34));}
</style></head><body>
  <div class="wall"></div>
  <div class="chase chase--a"></div>
  <div class="chase chase--b"></div>
  <div class="pipe pipe--hot"></div>
  <div class="pipe pipe--cold"></div>
  <div class="pipe pipe--riser"></div>
  <div class="cross"></div>
  <div class="floor"></div>
  <div class="vig"></div>
</body></html>
`;
