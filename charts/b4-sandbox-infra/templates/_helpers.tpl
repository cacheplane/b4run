{{/*
Chart name, truncated and trimmed for use in labels.
*/}}
{{- define "b4-sandbox-infra.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
The namespace all chart-managed objects live in.
*/}}
{{- define "b4-sandbox-infra.namespace" -}}
{{- .Values.namespace.name -}}
{{- end -}}

{{/*
Standard Helm recommended labels.

IMPORTANT: this deliberately does NOT emit `app.kubernetes.io/managed-by: b4`.
That label is the kubernetesSandbox provider's per-thread marker
(`app.kubernetes.io/managed-by=b4`), and the PVC reaper selects on it
(`-l app.kubernetes.io/managed-by=b4`). If this chart's own objects carried
that label, the reaper could mistake chart-managed resources (e.g. its own
future PVCs) for provider-managed sandbox PVCs. Helm's own `managed-by`
convention value is `Helm`, which is what we emit here instead.
*/}}
{{- define "b4-sandbox-infra.labels" -}}
app.kubernetes.io/name: {{ include "b4-sandbox-infra.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: Helm
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{/*
Orchestrator ServiceAccount name.
*/}}
{{- define "b4-sandbox-infra.orchestratorSAName" -}}
{{- .Values.orchestrator.serviceAccount.name -}}
{{- end -}}

{{/*
Reaper ServiceAccount name.
*/}}
{{- define "b4-sandbox-infra.reaperSAName" -}}
b4-reaper
{{- end -}}
