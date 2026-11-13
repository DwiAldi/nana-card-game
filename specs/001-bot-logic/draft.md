# Bot Logic

Single-player mode (one human versus 1–5 bots) uses **hard** bots that aim to maximize their win rate. Public-area reveals are random draws. A bot knows its complete, sorted hand, but can learn about other players and the public area only through observation and inference.

### Bot memory (perfect recall and inference)

Each bot maintains a global knowledge base, updated in real time:

- **Its own hand**: the complete ascending list, including duplicates. The bot knows the exact head (minimum), tail (maximum), and hand size.
- **Other players' hands**:
  - Current cards, both known and unknown.
  - Known head value: if that player's minimum card was revealed and that end has not subsequently been removed, the head still has that value.
  - Known tail value, under the same conditions.
  - Lower and upper bounds: a head value implies all cards are at least that value; a tail value implies all cards are at most that value.
  - Excluded numbers: infer numbers that cannot be in a player's hand using the global deck and observed cards.
  - Hands may contain duplicates, which are adjacent in sorted order. Revealing a head with duplicates leaves the head value unchanged until removal.
- **Collected sets of three**: each player's collected set count and exact numbers, including the bot's own sets, since all three cards are public on success.
- **Public area**:
  - Remaining cards, both known and unknown.
- **Global deck tracking**:
  - Remaining copies of each number from 1 to 12: initially three, minus collected sets and cards at known locations.
- **Reveal history**: every revealed card's value and source, used to continuously update these inferences.

Whenever any card is revealed, whether the challenge succeeds or fails, the bot immediately recalculates all probabilities and possible targets.

### Bot decision process (hard mode, maximizing win rate)

A bot may attempt multiple chains per turn until it fails. Its decision objective is to **maximize the expected number of sets collected during the current turn**.

#### Overall framework

The draft describes the chain states as four states, but enumerates these three: an empty chain, one revealed card (target number T), and two revealed cards (both T).

For each next reveal, enumerate every possible action (each player's head/tail and the public area). Calculate each action's **expected payoff** (success probability × reward, plus failure risk) and choose the highest.

Reward: successfully collecting a set of three earns +1 set, moving closer to victory.

#### Strict priorities (refining the proposed framework)

1. **Highest priority: a known, immediately completable set of three**

   - With two Ts already revealed, if an action guarantees another T (such as a player's known head/tail or the bot's own head/tail), choose that certain action immediately.
   - This is effectively mandatory: success is guaranteed and the turn continues.

2. **Second priority: two known matching cards (one T in the chain, or an empty chain that can start a valuable sequence)**

   - With one T already in the chain, find the remaining third T, preferring certain sources, then high-probability sources.
   - With an empty chain and two immediately accessible matching cards (for example, two known heads/tails with number S), reveal one to start, then seek the second S from a high-probability source, and finally reveal the guaranteed third copy.
   - Search strategy:
     - Scan all known heads/tails for T.
     - Calculate public-area probability: remaining copies of T / total remaining public cards.
     - Estimate unknown head/tail probabilities using the player's lower/upper bounds, excluded numbers, global remaining copies of T, and hand size. Approximate the probability that the end is T with a hypergeometric distribution.
     - Reveal the third card from the highest-probability source.
     - If all probabilities are low, consider abandoning the chain by deliberately revealing a mismatch to end the turn and avoid exposing information. A hard bot evaluates whether the risk is worthwhile.

3. **Medium priority: only one known card (explore a potential set)**

   - Scan all known heads/tails and the bot's own hand for numbers with the most remaining copies, preferring numbers with two or three copies remaining globally.
   - Prefer the largest or smallest known value as a starting point: extreme values often provide more information and are harder for opponents to exploit after exposure.
   - Then seek the other two copies:
     - Prefer high-probability sources as above: certainty, then public-area probability, then estimates for unknown ends.
     - Skip a number with only one remaining copy globally, since a set of three is impossible.

4. **Lowest priority: pure exploration (no good opportunities)**
   - Reveal information randomly, with a bias:
     - Prefer opponents' heads/tails, especially opponents with many cards, to learn lower/upper bounds.
     - Avoid revealing the bot's own heads/tails unless necessary, to limit information exposure.
     - Occasionally reveal a public card to establish known public values and reduce uncertainty.
   - Selection criterion: highest information value.
