FROM golang:1.25-alpine AS build
WORKDIR /app

RUN apk add --no-cache git

COPY apps/ingest-worker-go/go.mod ./go.mod
RUN go mod download

COPY apps/ingest-worker-go ./
RUN go build -o /out/sqs-consumer ./cmd/sqs-consumer

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=build /out/sqs-consumer /usr/local/bin/sqs-consumer

ENTRYPOINT ["/usr/local/bin/sqs-consumer"]
