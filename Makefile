SHELL := /bin/bash

COMPOSE := docker compose
API_URL := http://localhost:4000

.PHONY: up down rebuild ps logs logs-api logs-web logs-ingest logs-matcher seed-accounts seed-catalog seed-default-rules seed-all dashboard-workers dashboard-queue dashboard-pipeline

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

rebuild:
	$(COMPOSE) up -d --build --force-recreate

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f

logs-api:
	$(COMPOSE) logs -f api

logs-web:
	$(COMPOSE) logs -f web

logs-ingest:
	$(COMPOSE) logs -f ingest-worker

logs-matcher:
	$(COMPOSE) logs -f matcher-worker

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
