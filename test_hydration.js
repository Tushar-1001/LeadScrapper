const puppeteer = require('puppeteer-core');

async function testHydration() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors', '--lang=en-US,en'],
  });

  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', r => ['image', 'font', 'media', 'stylesheet'].includes(r.resourceType()) ? r.abort() : r.continue());

  const url = 'https://www.google.com/maps/place/Cathedral+Plumbing+of+Texas,+LLC/@32.9871345,-96.9244867,17z/data=!3m1!4b1!4m6!3m5!1s0x864c2f576c47e55d:0x3cfc19e0d7e85b94!8m2!3d32.9871345!4d-96.9244867!16s%2Fg%2F11csr174n1?hl=en';
  console.log('Navigating...');
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Wait specifically for address button or authority link (the place info pane)
  console.log('Waiting for place pane to hydrate...');
  await page.waitForSelector('button[data-item-id="address"], button[data-item-id*="phone"], a[data-item-id="authority"]', { timeout: 6000 }).catch(() => {});
  // Give it an extra 500ms
  await new Promise(r => setTimeout(r, 600));

  const elapsed = Date.now() - t0;
  const res = await page.evaluate(() => {
    const auth = document.querySelector('a[data-item-id="authority"]');
    return {
      authHref: auth ? auth.href : null,
      hasAddress: !!document.querySelector('button[data-item-id="address"]'),
      hasPhone: !!document.querySelector('button[data-item-id*="phone"]'),
    };
  });

  console.log(`Results after ${elapsed}ms:`, res);
  await browser.close();
}

testHydration();

