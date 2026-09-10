{{/*
Chart name, truncated and trimmed for use in labels.
*/}}
{{- define "b4-app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name. Truncated to 63 chars (DNS label limit) since
this is used to construct Kubernetes object names.
*/}}
{{- define "b4-app.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Standard Helm recommended labels.
*/}}
{{- define "b4-app.labels" -}}
app.kubernetes.io/name: {{ include "b4-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: Helm
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{/*
Selector labels — the stable subset used to match Pods (Deployment
selector, Service selector, PDB selector). Must NOT change across
releases/upgrades.
*/}}
{{- define "b4-app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "b4-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
The ServiceAccount name to use. An empty value follows the chart's
release-scoped fullname so the canonical b4-app release creates b4-app.
*/}}
{{- define "b4-app.serviceAccountName" -}}
{{- default (include "b4-app.fullname" .) .Values.serviceAccount.name -}}
{{- end -}}

{{/*
Full image reference: repository is required (fails fast with a clear
error if unset, rather than silently rendering `image: :tag`). Pins by
digest when set, else falls back to tag, else .Chart.AppVersion.
*/}}
{{- define "b4-app.image" -}}
{{- $repository := required "image.repository is required (e.g. --set image.repository=ghcr.io/you/your-app — see README)" .Values.image.repository -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" $repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}
