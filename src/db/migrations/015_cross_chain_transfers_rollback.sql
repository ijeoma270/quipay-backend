-- Rollback: cross_chain_transfers table

DROP TRIGGER IF EXISTS trigger_cct_updated_at ON cross_chain_transfers;
DROP FUNCTION IF EXISTS update_cross_chain_transfers_updated_at();
DROP TABLE IF EXISTS cross_chain_transfers CASCADE;
