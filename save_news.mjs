const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const puppeteer = require('puppeteer');

const args = process.argv.slice(2);
const pcnt = args[0] ?? 1 ;

var _srcu = 'https://finance.yahoo.com/topic/latest-news/';
var _file = '_pl';

const urlMap = new Map();
urlMap.set('_pl', 'https://finance.yahoo.com/topic/latest-news/');
urlMap.set('_pm', 'https://finance.yahoo.com/topic/stock-market-news/');
urlMap.set('_po', 'https://finance.yahoo.com/topic/yahoo-finance-originals/');
urlMap.set('_pp', 'https://finance.yahoo.com/topic/premium-news/');
urlMap.set('_pt', 'https://finance.yahoo.com/topic/tech/');
urlMap.set('_pe', 'https://finance.yahoo.com/economy/');

const title = '//ul//div[contains(@class, "title-row")]//h3/text()';
const ulink = '//ul//div[contains(@class, "title-row")]//a/@href';
const publr = '//ul//span[contains(@class, "publishing ")]//span[contains(@class, "publisher")]//text()';
const ptime = '//ul//span[contains(@class, "publishing ")]//span[contains(@class, "published-date")]//text()';

function extractHtmlText(html, regex) {
    const { document } = new JSDOM(html).window;

    const result = document.evaluate(
        regex,
        document,
        null,
        document.defaultView.XPathResult.ANY_TYPE,
        null
    );

    const reslt = [];
    let node = result.iterateNext();
    while (node) {
        reslt.push(node.textContent.trim());
        node = result.iterateNext();
    }
    return reslt;
}

(async () => {
	const browser = await puppeteer.launch({
		headless: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox']
	});

	let a, b, c, d;
	try {
		const page = await browser.newPage();

		await page.setViewport({ width: 1920, height: 1080 });
		await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');

		for (const [key, url] of urlMap) {
			console.info(`  parse ${url}`);

			orgf = key;
			dest = url;
			for (let i = 0; i < pcnt; i++) {
				s = i + 1;
				if ( s > 1) {
					dest = url + s
				}
				await page.goto(dest, {
					waitUntil: 'domcontentloaded',
					timeout: 10000
				});

				file = orgf + s + '.html'
				await new Promise((resolve) => setTimeout(resolve, 3000));
				const html = await page.content();
				fs.writeFileSync(file, html, 'utf8');

				const col_t = extractHtmlText(html, title);
				const col_u = extractHtmlText(html, ulink);
				const col_p = extractHtmlText(html, publr);
				const col_d = extractHtmlText(html, ptime);

				a = col_t.length;
				b = col_u.length;
				c = col_p.length;
				d = col_d.length;
				console.info(`  parse ${a} ${b} ${c} ${d} entries`);

				for (let j = 0; j < col_t.length; j++) {
					console.info('%s  %s   %s   %s',  (j+1), col_d[j].slice(0, 3), col_p[j].slice(0, 16), col_t[j]);
				}
				await sleep(3000);
			}
		}
	} catch (error) {
		console.error('error:', error);
		console.error(a, b, c, d);
	} finally {
		await browser.close();
	}
})();
