import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

const options = parseArgs(process.argv.slice(2));
const DATABASE_URL = options.databaseURL || process.env.DATABASE_URL;

if (!DATABASE_URL) {
	throw new Error('DATABASE_URL is required');
}
if (!options.username && !options.zoteroUserID) {
	throw new Error('Pass --username USERNAME or --zotero-user-id ID');
}

let password = options.password;
if (options.passwordFile) {
	password = fs.readFileSync(options.passwordFile, 'utf8').replace(/\r?\n$/, '');
}
if (!password && process.stdin.isTTY) {
	password = await promptHidden('New password: ');
}
if (!password) {
	throw new Error('Pass --password PASSWORD or --password-file PATH');
}

const pool = new Pool({ connectionString: DATABASE_URL });

try {
	let where;
	let params;
	if (options.username) {
		where = 'lower(username)=lower($2)';
		params = [hashPassword(password), options.username];
	}
	else {
		where = 'zotero_user_id=$2';
		params = [hashPassword(password), Number(options.zoteroUserID)];
	}

	let result = await pool.query(
		`UPDATE users SET password_hash=$1, updated_at=now() WHERE ${where} `
			+ "RETURNING id, zotero_user_id, username",
		params
	);
	let user = result.rows[0];
	if (!user) {
		throw new Error('No matching user found');
	}

	await pool.query(
		"UPDATE account_identity SET password_hash=$1, updated_at=now() WHERE user_id=$2",
		[params[0], user.zotero_user_id]
	);

	console.log(`Updated password for ${user.username} (${user.zotero_user_id})`);
}
finally {
	await pool.end();
}

function hashPassword(value) {
	let iterations = 100000;
	let salt = crypto.randomBytes(16).toString('hex');
	let hash = crypto.pbkdf2Sync(value, salt, iterations, 32, 'sha256').toString('hex');
	return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

function promptHidden(prompt) {
	return new Promise((resolve, reject) => {
		let input = '';
		let stdin = process.stdin;
		let stdout = process.stdout;

		stdout.write(prompt);
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding('utf8');

		function cleanup() {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.off('data', onData);
			stdout.write('\n');
		}

		function onData(char) {
			if (char == '\u0003') {
				cleanup();
				reject(new Error('Password prompt cancelled'));
				return;
			}
			if (char == '\r' || char == '\n') {
				cleanup();
				resolve(input);
				return;
			}
			if (char == '\u007f') {
				input = input.slice(0, -1);
				return;
			}
			input += char;
		}

		stdin.on('data', onData);
	});
}

function parseArgs(args) {
	let result = {};
	for (let i = 0; i < args.length; i++) {
		let arg = args[i];
		let next = () => {
			i++;
			if (i >= args.length) {
				throw new Error(`Missing value for ${arg}`);
			}
			return args[i];
		};
		if (arg == '--database-url') {
			result.databaseURL = next();
		}
		else if (arg == '--username') {
			result.username = next();
		}
		else if (arg == '--zotero-user-id') {
			result.zoteroUserID = next();
		}
		else if (arg == '--password') {
			result.password = next();
		}
		else if (arg == '--password-file') {
			result.passwordFile = next();
		}
		else {
			throw new Error(`Unknown option ${arg}`);
		}
	}
	return result;
}
