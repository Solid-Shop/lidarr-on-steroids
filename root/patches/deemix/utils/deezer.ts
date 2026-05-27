import { chromium, type Browser } from "playwright-core";

const stash: Map<string, string> = new Map();

const CHROMIUM_PATH =
	process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium-browser";

const LAUNCH_ARGS = [
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
	"--disable-gpu",
];

const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function harvestArl(email: string, password: string): Promise<string> {
	let browser: Browser | null = null;
	try {
		browser = await chromium.launch({
			headless: true,
			executablePath: CHROMIUM_PATH,
			args: LAUNCH_ARGS,
		});
		const ctx = await browser.newContext({ userAgent: USER_AGENT });
		const page = await ctx.newPage();

		console.log("[deemix-login] navigating to deezer.com/login");
		await page.goto("https://www.deezer.com/login", {
			waitUntil: "domcontentloaded",
			timeout: 30000,
		});

		try {
			await page
				.locator('#gdpr-btn-accept-all, button:has-text("Accept")')
				.first()
				.click({ timeout: 3000 });
		} catch {
			/* no cookie banner */
		}

		await page.fill('input[name="email"], input[type="email"]', email, {
			timeout: 15000,
		});
		await page.fill('input[name="password"], input[type="password"]', password);
		await page.click(
			'button[type="submit"], #login_form_submit, button:has-text("Login")'
		);

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
				.locator('[class*="error" i], .form-error, .alert-danger')
				.first()
				.textContent()
				.catch(() => null);
			if (
				visibleErr &&
				/password|invalid|incorrect|wrong|not match/i.test(visibleErr)
			) {
				throw new Error(
					`Deezer rejected the credentials: ${visibleErr.trim()}`
				);
			}

			await page.waitForTimeout(500);
		}

		throw new Error(
			"Timed out waiting for the arl cookie. Possible captcha, 2FA, or network issue."
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
