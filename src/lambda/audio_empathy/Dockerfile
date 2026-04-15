# checkov:skip=CKV_DOCKER_2:AWS Lambda manages container health checks
# checkov:skip=CKV_DOCKER_3:AWS Lambda base images manage user context internally
FROM public.ecr.aws/lambda/python:3.13

# Install ffmpeg static binary (not available in AL2023 default repos)
RUN dnf install -y tar xz && \
    curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o /tmp/ffmpeg.tar.xz && \
    tar -xf /tmp/ffmpeg.tar.xz -C /tmp && \
    cp /tmp/ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ffmpeg && \
    chmod +x /usr/local/bin/ffmpeg && \
    rm -rf /tmp/ffmpeg* && \
    dnf clean all

# Install Python dependencies
COPY src/lambda/audio_empathy/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy handler
COPY src/lambda/audio_empathy/index.py .

# Copy source modules needed by AudioEmpathyEvaluator
COPY src/recording/ src/recording/
COPY src/evaluators/ src/evaluators/
COPY src/__init__.py src/__init__.py

# nosemgrep: dockerfile.security.missing-user.missing-user
CMD ["index.lambda_handler"]
