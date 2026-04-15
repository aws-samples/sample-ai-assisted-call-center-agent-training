# checkov:skip=CKV_DOCKER_2:AWS Lambda manages container health checks
# checkov:skip=CKV_DOCKER_3:AWS Lambda base images manage user context internally
FROM public.ecr.aws/lambda/python:3.13

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Lambda handler
COPY index.py .

# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["index.handler"]
