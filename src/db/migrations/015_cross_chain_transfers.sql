-- Cross-chain transfer tracking for Circle CCTP v2
-- Tracks USDC deposits (EVM -> Stellar) and withdrawals (Stellar -> EVM)

CREATE TABLE IF NOT EXISTS cross_chain_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_address VARCHAR(56),
  worker_address VARCHAR(56),
  direction VARCHAR(16) NOT NULL,         -- 'deposit' or 'withdrawal'
  source_chain VARCHAR(32) NOT NULL,      -- 'stellar', 'ethereum', 'base', 'arbitrum', 'optimism'
  destination_chain VARCHAR(32) NOT NULL,
  amount NUMERIC(20, 7) NOT NULL,
  source_tx_hash VARCHAR(128) NOT NULL,
  destination_tx_hash VARCHAR(128),
  message_hash VARCHAR(128),              -- CCTP message hash for attestation lookup
  attestation TEXT,                       -- Circle's attestation signature
  cctp_message TEXT,                      -- Encoded CCTP payload for receiveMessage on destination
  status VARCHAR(32) DEFAULT 'pending',   -- 'pending' | 'attested' | 'completed' | 'failed'
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT cct_direction_check CHECK (direction IN ('deposit', 'withdrawal')),
  CONSTRAINT cct_status_check CHECK (status IN ('pending', 'attested', 'completed', 'failed')),
  CONSTRAINT cct_amount_positive CHECK (amount > 0)
);

-- Partial index for active transfers that need polling
CREATE INDEX idx_cct_status ON cross_chain_transfers(status) WHERE status IN ('pending', 'attested');

-- Employer and worker lookups
CREATE INDEX idx_cct_employer ON cross_chain_transfers(employer_address);
CREATE INDEX idx_cct_worker ON cross_chain_transfers(worker_address);

-- Unique constraint on burn tx hash to prevent duplicate indexing
CREATE UNIQUE INDEX idx_cct_source_tx_hash ON cross_chain_transfers(source_tx_hash);

-- Time-based queries
CREATE INDEX idx_cct_created_at ON cross_chain_transfers(created_at DESC);

-- Composite for employer + time queries (analytics)
CREATE INDEX idx_cct_employer_created ON cross_chain_transfers(employer_address, created_at DESC);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_cross_chain_transfers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_cct_updated_at
  BEFORE UPDATE ON cross_chain_transfers
  FOR EACH ROW
  EXECUTE FUNCTION update_cross_chain_transfers_updated_at();
