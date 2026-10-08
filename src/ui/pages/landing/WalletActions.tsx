import { Link } from "react-router-dom";

export default function WalletActions() {
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Link to="/onboarding/create" className="btn-primary flex-1">Create wallet</Link>
      <Link to="/onboarding/restore" className="btn-secondary flex-1">Import wallet</Link>
    </div>
  );
}
