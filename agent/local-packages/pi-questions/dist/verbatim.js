/** The user's own words: a ring of the last interactive inputs, and quote matching against it. */

export const RING_SIZE = 10;
export const MIN_QUOTE = 2;

const norm = (s        ) => s.replace(/\s+/g, " ").trim();

export class InputRing {
	                 inputs           = [];

	/** Only text the user typed in this session counts. rpc and extension input is ignored. */
	push(text        , source        )       {
		if (source !== "interactive" || !text.trim()) return;
		this.inputs.push(text);
		if (this.inputs.length > RING_SIZE) this.inputs.shift();
	}

	get size()         {
		return this.inputs.length;
	}

	/** The full input that contains the quote (whitespace-normalised, case-sensitive), newest first, or null. */
	match(quote        )                {
		const q = norm(quote);
		if (q.length < MIN_QUOTE) return null;
		for (let i = this.inputs.length - 1; i >= 0; i--) if (norm(this.inputs[i]).includes(q)) return this.inputs[i];
		return null;
	}
}

export function matchQuote(ring           , quote        )                {
	return ring.match(quote);
}
