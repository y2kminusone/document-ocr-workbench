// async function loadIncludes() {
//   const nodes = Array.from(document.querySelectorAll("[data-include]"));
//   await Promise.all(
//     nodes.map(async (node) => {
//       const path = node.getAttribute("data-include");
//       if (!path) return;
//       const res = await fetch(path);
//       if (!res.ok) {
//         console.warn(`Include failed: ${path}`);
//         return;
//       }
//       const html = await res.text();
//       node.outerHTML = html;
//     })
//   );
// }
console.log("🚀 boot.js 시작됨 - MIME type 확인 필요");

const urlParams = new URLSearchParams(window.location.search);
const noCache = urlParams.get("nocache") === "1";

async function loadIncludes() {
  console.log("🔧 loadIncludes 시작");
  const nodes = Array.from(document.querySelectorAll("[data-include]"));
  console.log("🔍 찾은 include 요소:", nodes.length);

  await Promise.all(
    nodes.map(async (node) => {
      const path = node.getAttribute("data-include");
      console.log("📥 로딩:", path);

      try {
        const res = await fetch(path, { cache: noCache ? "no-store" : "default" });
        const html = await res.text();
        console.log("✅ 성공:", path, html.length + "자");

        node.outerHTML = html;
      } catch (err) {
        console.error("❌ 실패:", path, err);
      }
    })
  );

  console.log("🎉 모든 partials 로드 완료");
}

(async () => {
  await loadIncludes();
  const appSrc = noCache ? `./src/app.js?v=${Date.now()}` : "./src/app.js";
  await import(appSrc);
})();
