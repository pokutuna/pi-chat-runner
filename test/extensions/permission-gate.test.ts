// permission-gate extension の denylist 判定ロジック (純粋関数) の単体テスト。
// extension 本体は pi の ExtensionAPI に依存するため、matchDenylist だけを
// 直接テストする (docs/research/pi-tools-and-sandbox.md の方針通り、
// 事故防止層としての判定であり敵対的入力への境界ではないことを前提にした表)。
import { describe, expect, it } from "vitest";
import { matchDenylist } from "../../extensions/permission-gate.js";

describe("matchDenylist", () => {
	describe("blocked commands", () => {
		const blocked = [
			"apt install kubectl",
			"apt-get update && apt-get install -y curl",
			"dpkg -i foo.deb",
			"npm install -g typescript",
			"npm i -g typescript",
			"npm -g install typescript",
			"pip install requests",
			"pip3 install requests",
			"gem install rails",
			"brew install jq",
			"rm -rf /",
			"rm -fr /",
			"rm -rf / ",
			"mkfs.ext4 /dev/sda1",
			"dd if=/dev/zero of=/dev/sda",
			"chmod 777 /app",
			"chown -R agent /data/foo",
			"chmod 700 /etc/passwd",
			"chown root /usr/local/bin/pi",
			"chmod 777 /root/.ssh",
			"kill -9 1",
			"kill -KILL 1",
		];
		for (const command of blocked) {
			it(`blocks: ${command}`, () => {
				expect(matchDenylist(command)).toBeDefined();
			});
		}
	});

	describe("allowed commands", () => {
		const allowed = [
			"ls -la",
			"git status",
			"git clone https://example.com/repo.git",
			"curl -s https://example.com",
			"rg 'foo' src/",
			"fd -e ts",
			"jq '.foo' data.json",
			"rm -rf /tmp/pi-chat-runner/sessions/C01/T01",
			"rm -rf ./build",
			"pip install --user requests",
			"chmod 700 ./workdir",
			"chown agent:agent ./workdir/file.txt",
			"kill -9 12345",
		];
		for (const command of allowed) {
			it(`allows: ${command}`, () => {
				expect(matchDenylist(command)).toBeUndefined();
			});
		}
	});

	it("returns the matched reason so callers can surface it to the agent", () => {
		const match = matchDenylist("apt-get install -y kubectl");
		expect(match?.reason).toMatch(/apt/i);
		expect(match?.reason).toMatch(/not allowed/i);
	});
});
