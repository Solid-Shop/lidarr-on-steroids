import { type ApiHandler } from "@/types.js";
import { getAccessToken, getArlFromAccessToken } from "@/deemixApp.js";
import { saveLoginCredentials } from "@/helpers/loginStorage.js";

const path = "/loginEmail";

const handler: ApiHandler["handler"] = async (req, res) => {
	const isSingleUser = req.app.get("isSingleUser");
	const { email, password } = req.body;
	let accessToken = req.body.accessToken;

	try {
		if (!accessToken) {
			accessToken = await getAccessToken(email, password);
			if (accessToken === "undefined") accessToken = undefined;
		}

		let arl;
		if (accessToken) arl = await getArlFromAccessToken(accessToken);

		if (!accessToken) {
			console.error(
				"[deemix-login] /loginEmail: no access token produced from credentials"
			);
		} else if (!arl) {
			console.error(
				"[deemix-login] /loginEmail: access token obtained but ARL harvest returned null"
			);
		} else {
			console.log(
				`[deemix-login] /loginEmail: ARL harvested (${arl.length} chars); writing to login.json`
			);
		}

		if (isSingleUser && accessToken)
			saveLoginCredentials({
				accessToken,
				arl: arl || null,
			});

		res.send({ accessToken, arl });
	} catch (err) {
		console.error("[deemix-login] /loginEmail handler error:", err);
		res.status(500).send({
			accessToken: undefined,
			arl: undefined,
			error: err instanceof Error ? err.message : String(err),
		});
	}
};

const apiHandler = { path, handler };

export default apiHandler;
