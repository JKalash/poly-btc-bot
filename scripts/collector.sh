#!/bin/zsh
# Durable collector entrypoint for launchd. Starts the full stack (API with
# embedded engine + web) so data collection and the dashboard survive
# terminal/session closes. Logs to data/logs/ (gitignored).
export PATH="/Users/jkalash/.nvm/versions/node/v22.21.1/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/jkalash/Desktop/5min_btc_poly || exit 1
mkdir -p data/logs
exec pnpm dev >> data/logs/collector.log 2>&1
