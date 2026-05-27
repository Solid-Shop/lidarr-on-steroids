import { chromium, type Browser, type Page, type BrowserContext } from "playwright-core";
import fs from "fs";
import path from "path";

const stash: Map<string, string> = new Map();

const CHROMIUM_PATH =
	process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium-browser";

const LAUNCH_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
	"--disable-gpu",
	"--disable-blink-features=AutomationControlled",
	"--lang=en-US,en",
];

const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DEBUG_DIR =
	process.env.DEEMIX_LOGIN_DEBUG_DIR || "/config_deemix/login-debug";

async function ensureDebugDir() {
	try {
		await fs.promises.mkdir(DEBUG_DIR, { recursive: true });
	} catch {
		/* ignore */
	}
}

async function dumpDebug(page: Page, ctx: BrowserContext, tag: string) {
	try {
		await ensureDebugDir();
		const ts = Date.now();
		const shot = path.join(DEBUG_DIR, `${tag}-${ts}.png`);
		const html = path.join(DEBUG_DIR, `${tag}-${ts}.html`);
		const meta = path.join(DEBUG_DIR, `${tag}-${ts}.json`);
		await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
		const body = await page.content().catch(() => "");
		await fs.promises.writeFile(html, body).catch(() => {});
		const cookies = await ctx.cookies("https://www.deezer.com").catch(() => []);
		const url = page.url();
		await fs.promises
			.writeFile(
				meta,
				JSON.stringify(
					{
						url,
						cookieNames: cookies.map((c) => c.name),
						hasArl: cookies.some((c) => c.name === "arl"),
						title: await page.title().catch(() => null),
					},
					null,
					2
				)
			)
			.catch(() => {});
		console.error(
			`[deemix-login] debug dump saved: ${shot}, ${html}, ${meta} (page url: ${url})`
		);
	} catch (err) {
		console.error("[deemix-login] failed to dump debug:", err);
	}
}

async function tryFill(page: Page, selectors: string[], value: string) {
	for (const sel of selectors) {
		try {
			await page.fill(sel, value, { timeout: 5000 });
			console.log(`[deemix-login] filled selector ${sel}`);
			return sel;
		} catch {
			/* try next */
		}
	}
	throw new Error(`None of the selectors matched: ${selectors.join(" | ")}`);
}

async function tryClick(page: Page, selectors: string[]) {
	for (const sel of selectors) {
		try {
			await page.click(sel, { timeout: 5000 });
			console.log(`[deemix-login] clicked selector ${sel}`);
			return sel;
		} catch {
			/* try next */
		}
	}
	throw new Error(`None of the click selectors matched: ${selectors.join(" | ")}`);
}

async function harvestArl(email: string, password: string): Promise<string> {
	let browser: Browser | null = null;
	let ctx: BrowserContext | null = null;
	let page: Page | null = null;
	try {
		browser = await chromium.launch({
			headless: true,
			executablePath: CHROMIUM_PATH,
			args: LAUNCH_ARGS,
		});
		ctx = await browser.newContext({
			userAgent: USER_AGENT,
			locale: "en-US",
			timezoneId: "America/New_York",
			viewport: { width: 1280, height: 800 },
		});
		await ctx.addInitScript(
			`Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`
		);
		page = await ctx.newPage();

		console.log("[deemix-login] navigating to deezer.com/login");
		await page.goto("https://www.deezer.com/login", {
			waitUntil: "domcontentloaded",
			timeout: 30000,
		});
		console.log(`[deemix-login] page loaded, url=${page.url()}, title=${await page.title()}`);

		try {
			await page
				.locator(
					'#gdpr-btn-accept-all, #onetrust-accept-btn-handler, button:has-text("Accept"), button:has-text("I agree")'
				)
				.first()
				.click({ timeout: 5000 });
			console.log("[deemix-login] dismissed cookie banner");
		} catch {
			console.log("[deemix-login] no cookie banner to dismiss");
		}

		try {
			await tryFill(
				page,
				[
					'input[name="mail"]',
					'input[name="email"]',
					'input[type="email"]',
					'input[autocomplete="email"]',
					'input#login_mail',
				],
				email
			);
			await tryFill(
				page,
				[
					'input[name="password"]',
					'input[type="password"]',
					'input[autocomplete="current-password"]',
					'input#login_password',
				],
				password
			);
		} catch (err) {
			await dumpDebug(page, ctx, "fill-failed");
			throw err;
		}

		try {
			await tryClick(page, [
				'button[type="submit"]',
				'#login_form_submit',
				'button.form-submit',
				'button:has-text("Log in")',
				'button:has-text("Login")',
				'button:has-text("Sign in")',
			]);
		} catch (err) {
			await dumpDebug(page, ctx, "submit-failed");
			throw err;
		}

		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			const cookies = await ctx.cookies("https://www.deezer.com");
			const arlCookie = cookies.find((c) => c.name === "arl");
			if (arlCookie && arlCookie.value && arlCookie.value.length >= 150) {
				console.log(
					`[deemix-login] arl cookie captured (${arlCookie.value.length} chars)`
				);
				return arlCookie.value;
			}

			const visibleErr = await page
				.locator('[class*="error" i], .form-error, .alert-danger, [role="alert"]')
				.first()
				.textContent()
				.catch(() => null);
			if (
				visibleErr &&
				/password|invalid|incorrect|wrong|not match|captcha|verify/i.test(
					visibleErr
				)
			) {
				await dumpDebug(page, ctx, "login-error");
				throw new Error(
					`Deezer rejected the login: ${visibleErr.trim()}`
				);
			}

			await page.waitForTimeout(500);
		}

		await dumpDebug(page, ctx, "timeout");
		throw new Error(
			"Timed out waiting for the arl cookie. Possible captcha, 2FA, or network issue. See /config_deemix/login-debug/ for screenshot + HTML."
		);
	} finally {
		if (browser) {
			try {
				await browser.close();
			} catch {
				/* ignore */
			}
		}
	}
}

export async function getDeezerAccessTokenFromEmailPassword(
	email: string,
	password: string
) {
	try {
		const arl = await harvestArl(email, password);
		const token = `pw-${Date.now().toString(36)}-${Math.random()
			.toString(36)
			.slice(2, 10)}`;
		stash.set(token, arl);
		return token;
	} catch (err) {
		console.error("[deemix-login] getDeezerAccessTokenFromEmailPassword:", err);
		return null;
	}
}

export async function getDeezerArlFromAccessToken(accessToken: string) {
	if (!accessToken) return null;
	const arl = stash.get(accessToken);
	if (!arl) {
		console.error(
			"[deemix-login] getDeezerArlFromAccessToken: no ARL stashed for token (Playwright path expects the same call sequence the WebUI uses)"
		);
		return null;
	}
	stash.delete(accessToken);
	return arl;
}
