const puppeteer = require('puppeteer-core');

async function testCathedral() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors', '--lang=en-US,en'],
  });

  const page = await browser.newPage();
  await page.goto('https://www.google.com/maps/search/Cathedral+Plumbing+of+Texas+Carrollton+TX?hl=en&gl=us', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 2000));

  const res = await page.evaluate(() => {
    const auth = document.querySelector('a[data-item-id="authority"]');
    const allA = Array.from(document.querySelectorAll('a')).map(a => ({
      href: a.href,
      text: a.innerText,
      aria: a.getAttribute('aria-label'),
      id: a.getAttribute('data-item-id')
    }));
    return {
      url: window.location.href,
      authHref: auth ? auth.href : null,
      extLinks: allA.filter(x => x.href && !x.href.includes('google.com'))
    };
  });

  console.log('Result for Cathedral:', JSON.stringify(res, null, 2));
  await browser.close();
}

testCathedral();

