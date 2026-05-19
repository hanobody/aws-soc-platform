import json
import uuid
import boto3
import urllib.request
import urllib.parse
from datetime import datetime, timezone

sqs = boto3.client("sqs", region_name="ap-southeast-1")
QUEUE_URL = "https://sqs.ap-southeast-1.amazonaws.com/809893975949/soc-cloudtrail-events"
TELEGRAM_BOT_TOKEN = "7800308079:AAFNidRY84WgCYBef9NRawpIZD0-5VDDB8k"
TELEGRAM_CHAT_ID = "-5122851851"


def extract_resource(detail):
    event_name = detail.get("eventName")
    req = detail.get("requestParameters") or {}
    res = detail.get("responseElements") or {}
    resources = detail.get("resources") or []

    nested_perm = req.get("CreateNetworkInterfacePermissionRequest") or {}
    group_set = req.get("groupSet") or {}
    group_items = group_set.get("items") or []
    first_group = group_items[0] if group_items else {}
    first_resource = resources[0] if resources else {}
    response_eni = (res.get("networkInterface") or {}) if isinstance(res, dict) else {}

    network_interface_id = (
        response_eni.get("networkInterfaceId")
        or res.get("networkInterfaceId")
        or nested_perm.get("NetworkInterfaceId")
        or req.get("networkInterfaceId")
        or req.get("NetworkInterfaceId")
    )
    security_group_id = req.get("groupId") or first_group.get("groupId") or res.get("groupId")
    subnet_id = req.get("subnetId") or response_eni.get("subnetId") or res.get("subnetId")
    instance_id = req.get("instanceId") or res.get("instanceId")
    user_name = req.get("userName")
    role_name = req.get("roleName")
    bucket_name = req.get("bucketName")
    resource_arn = first_resource.get("ARN") or first_resource.get("arn")
    resource_type_hint = first_resource.get("type")

    if event_name in {"CreateNetworkInterface", "CreateNetworkInterfacePermission"}:
        resource_type = "network-interface"
    elif network_interface_id:
        resource_type = "network-interface"
    elif security_group_id or req.get("groupName"):
        resource_type = "security-group"
    elif instance_id:
        resource_type = "ec2-instance"
    elif user_name:
        resource_type = "iam-user"
    elif role_name:
        resource_type = "iam-role"
    elif bucket_name:
        resource_type = "s3-bucket"
    elif resource_type_hint:
        resource_type = resource_type_hint
    else:
        resource_type = None

    if event_name == "CreateNetworkInterface":
        resource_id = network_interface_id or subnet_id or security_group_id or resource_arn
    elif event_name == "CreateNetworkInterfacePermission":
        resource_id = network_interface_id or subnet_id or security_group_id or resource_arn
    else:
        resource_id = (
            security_group_id
            or network_interface_id
            or subnet_id
            or instance_id
            or user_name
            or role_name
            or bucket_name
            or resource_arn
        )

    resource_name = (
        req.get("groupName")
        or user_name
        or role_name
        or bucket_name
    )

    return {
        "resource_type": resource_type,
        "resource_id": resource_id,
        "resource_name": resource_name,
        "resource_arn": resource_arn,
    }


def build_message(event):
    detail = event.get("detail") or {}
    resource = extract_resource(detail)
    event_id = detail.get("eventID") or str(uuid.uuid4())

    return {
        "schema_version": "cloudtrail.event.v1",
        "event_id": event_id,
        "dedup_key": event_id,
        "ingest_source": "eventbridge.main-bus",
        "ingest_time": datetime.now(timezone.utc).isoformat(),
        "aws": {
            "account_id": str(event.get("account") or detail.get("recipientAccountId") or ""),
            "region": event.get("region") or detail.get("awsRegion") or "",
            "partition": "aws",
        },
        "event": {
            "source": event.get("source"),
            "detail_type": event.get("detail-type"),
            "event_source": detail.get("eventSource"),
            "event_name": detail.get("eventName"),
            "event_time": detail.get("eventTime") or event.get("time"),
            "event_category": detail.get("eventCategory"),
            "read_only": detail.get("readOnly"),
        },
        "actor": {
            "principal_type": ((detail.get("userIdentity") or {}).get("type")),
            "arn": ((detail.get("userIdentity") or {}).get("arn")),
            "account_id": ((detail.get("userIdentity") or {}).get("accountId")),
            "user_name": ((detail.get("userIdentity") or {}).get("userName")),
            "access_key_id": ((detail.get("userIdentity") or {}).get("accessKeyId")),
        },
        "network": {
            "source_ip": detail.get("sourceIPAddress"),
            "user_agent": detail.get("userAgent"),
        },
        "resource": resource,
        "request": {
            "request_id": detail.get("requestID"),
            "request_parameters": detail.get("requestParameters"),
            "response_elements": detail.get("responseElements"),
        },
        "raw_event": event,
    }


def send_telegram_alert(msg):
    text = (
        "✅ CloudTrail 事件已推送到 SQS\n"
        f"事件ID: {msg.get('event_id') or 'unknown'}\n"
        f"账号: {msg['aws']['account_id'] or 'unknown'}\n"
        f"区域: {msg['aws']['region'] or 'unknown'}\n"
        f"事件源: {msg['event']['event_source'] or 'unknown'}\n"
        f"事件名: {msg['event']['event_name'] or 'unknown'}\n"
        f"资源类型: {(msg.get('resource') or {}).get('resource_type') or 'unknown'}\n"
        f"资源ID: {(msg.get('resource') or {}).get('resource_id') or 'unknown'}"
    )

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = urllib.parse.urlencode({
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    with urllib.request.urlopen(req, timeout=10) as response:
        response.read()


def lambda_handler(event, context):
    msg = build_message(event)

    resp = sqs.send_message(
        QueueUrl=QUEUE_URL,
        MessageBody=json.dumps(msg, ensure_ascii=False),
        MessageAttributes={
            "account_id": {
                "DataType": "String",
                "StringValue": msg["aws"]["account_id"] or "unknown",
            },
            "event_source": {
                "DataType": "String",
                "StringValue": msg["event"]["event_source"] or "unknown",
            },
            "event_name": {
                "DataType": "String",
                "StringValue": msg["event"]["event_name"] or "unknown",
            },
            "region": {
                "DataType": "String",
                "StringValue": msg["aws"]["region"] or "unknown",
            }
        }
    )

    send_telegram_alert(msg)

    return {
        "ok": True,
        "message_id": resp.get("MessageId"),
        "event_id": msg["event_id"],
        "event_name": msg["event"]["event_name"],
    }
