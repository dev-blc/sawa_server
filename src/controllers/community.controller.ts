import { Request, Response } from 'express';
import { z } from 'zod';
import { communityService } from '../services/community.service';
import { sendSuccess } from '../utils/response';
import { validate } from '../middleware/validate';

// ─── Validation ─────────────────────────────────────────────────────────────

const CreateCommunitySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  city: z.string().min(1, 'City is required'),
  coverImageUrl: z.string().url().optional(),
  tags: z.array(z.string()).optional(),
  invitedCoupleIds: z.array(z.string()).optional(),
});

const JoinCommunitySchema = z.object({
  note: z.string().optional(),
});

export const validateCreateCommunity = validate(CreateCommunitySchema);
export const validateJoinCommunity = validate(JoinCommunitySchema);

// ─── Controllers ────────────────────────────────────────────────────────────

export const getAllCommunities = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  
  const communities = await communityService.getAllCommunities(coupleId!);
  
  sendSuccess({ res, statusCode: 200, data: { communities } });
};

export const getMyCommunities = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  
  const communities = await communityService.getMyCommunities(coupleId!);
  
  sendSuccess({ res, statusCode: 200, data: { communities } });
};

export const getCommunityDetail = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const { id } = req.params;

  const community = await communityService.getCommunityDetail(coupleId!, id);

  sendSuccess({ res, statusCode: 200, data: { community } });
};

export const createCommunity = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const data = req.body;

  const community = await communityService.createCommunity(coupleId!, {
    name: data.name,
    description: data.description,
    city: data.city,
    coverImageUrl: data.coverImageUrl,
    tags: data.tags || [],
    invitedCoupleIds: data.invitedCoupleIds || [],
  });

  sendSuccess({ 
    res, 
    statusCode: 201, 
    data: { community },
    message: 'Community created successfully!'
  });
};

export const joinCommunity = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const { id } = req.params;
  const data = req.body as z.infer<typeof JoinCommunitySchema>;

  const result = await communityService.joinCommunity(coupleId!, id, data.note);

  sendSuccess({ res, statusCode: 200, message: result.message, data: result });
};

export const leaveCommunity = async (_req: Request, _res: Response): Promise<void> => {
  // Stub
};

export const inviteToCommunity = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const { id } = req.params; // communityId
  const { invitedCoupleIds } = req.body;

  const result = await communityService.inviteToCommunity(coupleId!, id, invitedCoupleIds || []);

  sendSuccess({ res, statusCode: 200, data: result, message: 'Invites sent successfully' });
};

export const deleteCommunity = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const { id } = req.params;

  await communityService.deleteCommunity(coupleId!, id);

  sendSuccess({ res, statusCode: 200, message: 'Community deleted successfully' });
};

export const getInviteableCouples = async (req: Request, res: Response): Promise<void> => {
  const { coupleId } = req.user!;
  const { id } = req.params;

  const couples = await communityService.getInviteableCouples(coupleId!, id);

  sendSuccess({ res, statusCode: 200, data: { couples } });
};
