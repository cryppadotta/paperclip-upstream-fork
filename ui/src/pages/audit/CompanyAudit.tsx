import { useEffect } from "react";
import { ShieldCheck } from "lucide-react";
import { useCompany } from "../../context/CompanyContext";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { EmptyState } from "../../components/EmptyState";
import { AuditFeed } from "./AuditFeed";

/**
 * Company-level audit page. All company readers receive the redacted shared
 * feed; attribution filters and export remain permission-gated server-side.
 */
export function CompanyAudit() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Audit" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={ShieldCheck} message="Select a company to view the agent audit log." />;
  }

  return <AuditFeed companyId={selectedCompanyId} />;
}
