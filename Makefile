SHELL := /bin/bash

API_URL := http://localhost:4000

.PHONY: seed-accounts seed-catalog seed-default-rules seed-all dashboard-workers dashboard-queue dashboard-pipeline

seed-accounts:
	curl -s -X POST $(API_URL)/seed/accounts-regions | python3 -m json.tool

seed-catalog:
	curl -s -X POST $(API_URL)/seed/catalog | python3 -m json.tool

seed-default-rules:
	curl -s -X POST $(API_URL)/seed/default-rules | python3 -m json.tool

seed-all: seed-accounts seed-catalog seed-default-rules

dashboard-workers:
	curl -s $(API_URL)/dashboard/workers | python3 -m json.tool

dashboard-queue:
	curl -s $(API_URL)/dashboard/queue | python3 -m json.tool

dashboard-pipeline:
	curl -s $(API_URL)/dashboard/pipeline | python3 -m json.tool
