#!/usr/bin/env python3
"""Validate the RENDERED Kubernetes manifests for the x402 stack.

CI renders the kustomize set with `kubectl kustomize infrastructure/kubernetes`
and pipes it here. Re-rendering already catches duplicate resources and broken
$refs; kubeconform validates field-level correctness. This script asserts the
*behavioural* invariants that are easy to regress silently — the ones that
matter during an incident:

  * HTTP Deployments gate readiness on the dependency-aware `/health/ready`
    probe (liveness must stay on `/health`, or a datastore blip restart-loops);
  * PodDisruptionBudgets exist for the HTTP tier;
  * NetworkPolicies exist (segmentation wasn't accidentally dropped);
  * every `serviceAccountName` referenced by a workload exists in the set.

Usage: python3 scripts/validate-kubernetes.py <rendered.yaml>
"""

from __future__ import annotations

import sys

import yaml

HTTP_TIER = ("gateway", "dashboard")


def _by_kind(docs: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for doc in docs:
        if doc and doc.get("kind"):
            out.setdefault(doc["kind"], []).append(doc)
    return out


def _pod_spec(workload: dict) -> dict:
    return workload.get("spec", {}).get("template", {}).get("spec", {})


def main(path: str) -> int:
    with open(path, encoding="utf-8") as handle:
        docs = [d for d in yaml.safe_load_all(handle) if d]

    kinds = _by_kind(docs)
    errors: list[str] = []

    # ── Readiness gating: the gateway must probe the dependency-aware path ──
    gateway = next(
        (d for d in kinds.get("Deployment", []) if d["metadata"]["name"] == "gateway"),
        None,
    )
    if gateway is None:
        errors.append("no 'gateway' Deployment found")
    else:
        containers = _pod_spec(gateway).get("containers", [])
        if not containers:
            errors.append("gateway Deployment has no containers")
        else:
            container = containers[0]
            ready = container.get("readinessProbe", {}).get("httpGet", {}).get("path")
            live = container.get("livenessProbe", {}).get("httpGet", {}).get("path")
            if ready != "/health/ready":
                errors.append(
                    f"gateway readinessProbe path is {ready!r}, expected '/health/ready' "
                    "(a static /health probe keeps unhealthy pods in rotation)"
                )
            if live != "/health":
                errors.append(
                    f"gateway livenessProbe path is {live!r}, expected '/health' "
                    "(liveness must not depend on Postgres/Redis)"
                )

    # ── PodDisruptionBudgets cover the HTTP tier ──
    pdbs = {d["metadata"]["name"] for d in kinds.get("PodDisruptionBudget", [])}
    for name in HTTP_TIER:
        if name not in pdbs:
            errors.append(f"missing PodDisruptionBudget for '{name}'")

    # ── Network segmentation present ──
    if not kinds.get("NetworkPolicy"):
        errors.append("no NetworkPolicy resources found")

    # ── serviceAccountName references resolve ──
    service_accounts = {d["metadata"]["name"] for d in kinds.get("ServiceAccount", [])}
    for kind in ("Deployment", "StatefulSet", "Job"):
        for workload in kinds.get(kind, []):
            name = workload["metadata"]["name"]
            ref = _pod_spec(workload).get("serviceAccountName")
            if ref and ref not in service_accounts:
                errors.append(f"{kind}/{name} references unknown ServiceAccount {ref!r}")

    if errors:
        for error in errors:
            # ::error:: renders as an annotation on the PR/run.
            print(f"::error::{error}")
        print(f"\n{len(errors)} manifest invariant(s) failed")
        return 1

    print(
        f"OK — {len(docs)} resources; readiness gating, PDBs, "
        "ServiceAccounts and NetworkPolicies verified"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "rendered.yaml"))
