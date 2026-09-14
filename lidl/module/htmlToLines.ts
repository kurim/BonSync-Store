/** Wandelt eine HTML-Belegkopie (LIDL: `htmlPrintedReceipt`) in Textzeilen um, damit sie durch
 * dieselben zeilenbasierten Parser laufen kann wie ein PDF-Beleg (siehe ../_shared/posParser). */

const BLOCK_TAGS = /<\/(tr|div|p|li|h[1-6])>|<br\s*\/?>/gi;
const ANY_TAG = /<[^>]+>/g;

const ENTITY_MAP: Record<string, string> = {
	nbsp: ' ',
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	euro: '€'
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
		if (entity[0] === '#') {
			const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return ENTITY_MAP[entity.toLowerCase()] ?? match;
	});
}

export function htmlToLines(html: string): string[] {
	const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
	const withBreaks = withoutScripts.replace(BLOCK_TAGS, '\n');
	const textOnly = decodeEntities(withBreaks.replace(ANY_TAG, ''));
	return textOnly
		.split('\n')
		.map((line) => line.replace(/\s+/g, ' ').trim())
		.filter((line) => line.length > 0);
}
