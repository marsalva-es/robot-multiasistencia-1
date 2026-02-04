const { chromium } = require('playwright');
const admin = require('firebase-admin');
const http = require('http'); // <--- NUEVO: Necesario para crear el servidor

// ==============================================================================
// 🟢 TRUCO PARA RENDER: Servidor web "falso" para mantener el despliegue vivo
// ==============================================================================
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Robot Multiasistencia funcionando correctamente');
});

server.listen(port, () => {
  console.log(`🌍 Servidor web escuchando en puerto ${port} (Requisito de Render)`);
});
// ==============================================================================


if (!admin.apps.length) {
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    console.error("❌ Faltan variables FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY");
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: String(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();
const COLLECTION_PENDIENTES = "multiasistencia_pendientes";
const LOGIN_URL = "https://web.multiasistencia.com/w3multi/acceso.php";
const LIST_URL = "https://web.multiasistencia.com/w3multi/frepasos_new.php?refresh=1";

/**
 * Rellena el primer selector disponible de una lista (separados por coma).
 */
async function fillFirst(page, selector, value, label) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible', timeout: 60000 });
  await loc.fill(String(value ?? ""));
  console.log(`✅ ${label} rellenado`);
}

/**
 * Click en el primer selector disponible.
 */
async function clickFirst(page, selector, label) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible', timeout: 60000 });
  await loc.click();
  console.log(`✅ Click: ${label}`);
}

/**
 * Si hay banner de cookies/aviso, intenta aceptarlo (no rompe si no existe).
 */
async function tryAcceptCookies(page) {
  const candidates = [
    'button:has-text("Aceptar")',
    'button:has-text("ACEPTAR")',
    'button:has-text("Accept")',
    'button:has-text("OK")',
    'input[type="button"][value*="Aceptar" i]',
    'input[type="submit"][value*="Aceptar" i]',
  ];

  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click();
        console.log("🍪 Banner aceptado");
        return;
      }
    } catch (_) {}
  }
}

async function runMultiasistencia() {
  console.log(`\n🕒 [${new Date().toLocaleTimeString()}] Iniciando ciclo...`);

  // 1) Cargar credenciales
  let user, pass;
  try {
    const credSnap = await db.collection("providerCredentials").doc("multiasistencia").get();
    if (!credSnap.exists) {
      console.error("❌ No hay credenciales en Firestore: providerCredentials/multiasistencia");
      return;
    }
    user = (credSnap.data().user || "").toString();
    pass = (credSnap.data().pass || "").toString();
    if (!user || !pass) {
      console.error("❌ Credenciales incompletas (user/pass vacíos)");
      return;
    }
  } catch (e) {
    console.error("❌ Error Firestore:", e.message);
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    // A veces ayuda si la web se pone tonta con bots
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  try {
    // 2) Login
    console.log("🔐 Abriendo login...");
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await tryAcceptCookies(page);

    // Debug rápido: qué inputs hay realmente (si vuelve a fallar, esto nos salva)
    try {
      const inputs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input')).map(i => ({
          name: i.getAttribute('name'),
          id: i.id || null,
          type: i.getAttribute('type') || null,
        }));
      });
      console.log("🧩 Inputs detectados:", inputs);
    } catch (_) {}

    // Selectores robustos:
    const userSelector =
      'input[name="usuario"], input#usuario, input[id*="usuario" i], input[name*="user" i], input[type="text"]';
    const passSelector =
      'input[name="password"], input[name="pass"], input[name="clave"], input[id*="pass" i], input[type="password"]';
    const submitSelector =
      'input[type="submit"], button[type="submit"], button:has-text("Entrar"), input[value*="Entrar" i]';

    await fillFirst(page, userSelector, user, "Usuario");
    await fillFirst(page, passSelector, pass, "Password");
    await clickFirst(page, submitSelector, "Submit");

    // Espera a que algo cambie (navegación o carga)
    await page.waitForTimeout(4000);

    // 3) Ir a lista
    console.log("📂 Abriendo listado...");
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForTimeout(3000);

    let tieneSiguiente = true;
    let paginaActual = 1;

    while (tieneSiguiente) {
      const expedientes = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="reparacion="]'));
        return Array.from(new Set(
          links
            .map(a => a.href.match(/reparacion=(\d+)/)?.[1])
            .filter(Boolean)
        ));
      });

      console.log(`📄 Página ${paginaActual}: encontrados ${expedientes.length} expedientes`);

      for (const ref of expedientes) {
        const detalleUrl =
          `https://web.multiasistencia.com/w3multi/repasos1.php?reparacion=${ref}` +
          `&navid=%2Fw3multi%2Ffrepasos_new.php%FDPOST%FDreparacion%3D%FCrefresh%3D%FCpaginasiguiente%3D${paginaActual}` +
          `%FCcmbgremio%3D%FCcmbestado%3D%FCestado%3D%FCfprocedencia%3D%FCvigencia%3D%FCcolor%3D%FCtiposervicio%3D%FCgremio%3D%FCfurgente%3D%FCfcomarca%3D%FC`;

        try {
          await page.goto(detalleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

          const scrapData = await page.evaluate(() => {
            const td = Array.from(document.querySelectorAll('td'));
            const findValue = (text) => {
              const i = td.findIndex(el => (el.innerText || "").toUpperCase().includes(text.toUpperCase()));
              return i !== -1 ? (td[i + 1]?.innerText || "").trim() : "";
            };

            const bodyText = document.body?.innerText || "";
            const phoneMatch = bodyText.match(/[6789]\d{8}/);

            return {
              clientName: findValue("Nombre"),
              address: findValue("Dirección") || findValue("Domicilio"),
              phone: phoneMatch?.[0] || "Sin teléfono",
              company: findValue("Compañía") || findValue("Seguro"),
            };
          });

          if (scrapData.clientName) {
            await db.collection(COLLECTION_PENDIENTES).doc(ref).set({
              ...scrapData,
              serviceNumber: ref,
              status: "pendiente_validacion",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true
