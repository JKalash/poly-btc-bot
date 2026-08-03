# Live trading — how to actually place real orders

This release CAN trade real money, but ships **disarmed and unconfigured**. Live orders require
three separate, deliberate steps: configure a wallet, arm with a typed acknowledgement + re-auth,
and the strategy must then find edge that clears every safety gate. Any halt, kill, restart, or the
expiry timer disarms instantly.

> The research in `docs/research/` says expected value on these markets is likely **negative** after
> the 7% fee and adverse selection. Arming is an informed bet against that, bounded by your risk
> profile. Fund the wallet only with money you are at peace to lose.

## 1. Make a wallet (do NOT use your main one)

1. Create a fresh wallet (MetaMask or any Polygon-capable wallet). This is a **hot wallet** — its
   key lives on the server — so keep only trading funds in it.
2. Fund it on **Polygon** with:
   - **USDC.e** (the bridged USDC Polymarket uses as collateral) — start with $50–200.
   - a little **POL/MATIC** (~$1) for gas on the one-time allowance transaction.
3. Deposit into Polymarket / set collateral so the CLOB sees your balance. (If you normally trade
   through Polymarket's UI proxy wallet, use that funder address; for a plain EOA hot wallet the
   funder is the wallet's own address, which is the default.)
4. Export the wallet's **private key** (0x + 64 hex).

## 2. Configure the server (secrets — never in chat, never in git)

```bash
fly secrets set -a b5p-collector \
  LIVE_TRADING_ENABLED=1 \
  HOT_WALLET_PRIVATE_KEY=0xYOUR_KEY \
  # optional, only if you trade through a Polymarket proxy wallet:
  # FUNDER_ADDRESS=0xYOUR_PROXY_ADDRESS
```

The machine restarts and the live adapter loads **disarmed**. The key is read once into memory,
converted to a signer, and is never logged, returned, or written to the database (an output
redactor strips any 64-hex string as defense in depth). Verify it loaded: the Risk page's "LIVE
TRADING" card changes from "NOT CONFIGURED" to "DISARMED".

One-time allowance (lets the exchange move your USDC): the first arm runs a preflight that reports
if allowance is missing. If it is, the engine can set it (an on-chain tx costing gas), or you can
approve the CTF Exchange spender from the Polymarket UI once.

## 3. Align config so trades can actually fire

The strategy's economic gates still apply live. For the late-snipe experiment to trade live you must
lower the live entry cutoff to inside the snipe window (Configuration page):

```
strategy.live_entry_cutoff_seconds: 20     # default 60 blocks a 20-40s snipe
strategy.live_price_ceiling: 0.90          # or lower; hard ceiling on price paid
strategy.allow_taker: true
risk.profile: very_aggressive              # live-capable; 10% max/trade, -15% session, -20% day, 2-loss halt
```

The absolute 10%/trade cap and the no-all-in / no-martingale rules cannot be configured away.

## 4. Arm (Risk page → "LIVE TRADING" card)

1. Type the acknowledgement phrase **exactly**.
2. Enter your operator password (re-authentication for this control).
3. Choose a TTL (15–120 min). Arming **auto-expires** — you re-arm to continue.
4. The engine runs wallet reconciliation (reachable CLOB, derivable API creds, USDC balance +
   allowance ≥ minimum). If it fails, it stays disarmed and shows why.

Once armed: approved decisions route to the **live** adapter instead of paper. Each still passes
edge/break-even, caps, staleness, clock-drift, price-ceiling, cutoff, and drawdown-stop gates —
arming only bypasses the two "this strategy is unproven" governance gates, which the acknowledgement
explicitly accepts.

## 5. What auto-disarms you (no action needed)

Restart/deploy, kill switch / emergency stop, any engine halt (feed staleness, resolution mismatch,
DB failure), wallet balance becoming unreadable, session/daily drawdown stop, 2 consecutive losses,
and the TTL expiry. After any of these you must deliberately re-arm.

## Limitations (see also docs/limitations.md)

- **Fill accounting is approximate.** A live FAK fill is recorded at the requested price; exact
  executed prices/fees reconcile from CLOB trade history in a later pass — P&L is close but not yet
  penny-exact until then.
- **Winning-position redemption is manual.** Resolved winning CTF tokens convert to USDC via an
  on-chain redeem; the engine re-reads your balance but does not yet auto-redeem. Redeem from the
  Polymarket UI, or a redemption job is a follow-up.
- **Maker cancels on live** are best-effort via `cancelAll`; unresolved cancel state should be
  checked in the Orders view.
- Verify Polymarket's geographic terms for your jurisdiction before funding.
